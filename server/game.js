'use strict';
// Pure Cambrio rules engine. No networking here: the server calls
// game.act(playerId, action) and sends each player game.view(playerId).
//
// House rules:
//   7, 8   -> look at one of your own cards
//   9, 10  -> look at one card of another player
//   J, Q   -> swap any 2 cards (blind)
//   Black K-> look at any 2 cards, then you may swap any 2 cards
//   Red K  -> worth -1 point
//   Joker  -> worth 0 points
// Powers only trigger when the card is drawn from the deck and discarded
// straight away (not when it is swapped out of a hand).
// You can only draw from the deck (never from the discard pile).
// Sticking: anyone may stick any player's card whose rank matches the top
// discard, as often as they like. Sticking another player's card means you
// give them one of yours. A wrong stick: the card goes back and the sticker
// takes a penalty card.
// Ties: the Cambrio caller wins ties; otherwise the lowest single card wins.

const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const RED = new Set(['H', 'D']);
const HAND_SIZE = 4; // default; rooms can choose 4 or 6
const HAND_SIZES = [4, 6];
// At the start each player sees their bottom row (the cards nearest them).
// 4 cards = 2x2 grid, so slots 2-3. 6 cards = 3x2 grid, so slots 3-5.
const PEEK_SLOTS = { 4: [2, 3], 6: [3, 4, 5] };
const INITIAL_PEEK_SLOTS = PEEK_SLOTS[4];
const MAX_PLAYERS_BY_HAND = { 4: 8, 6: 6 }; // keep enough cards in the deck
const MIN_PLAYERS = 2;
const TURN_TIMER_CHOICES = [0, 10, 15, 20, 30, 60]; // seconds; 0 = no timer
const GIVE_TIMEOUT_MS = 20000; // the server gives a random card if a sticker takes longer
const MAX_PLAYERS = 8;
// Private rooms can pick a mode. easy: cards you have seen stay face up for you.
// hard: you can write notes on cards and see which cards have not been discarded yet.
const MODES = ['easy', 'normal', 'hard'];
const NOTE_RANKS = ['JOKER', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function isRed(card) {
  return RED.has(card.suit);
}

function cardValue(card) {
  if (card.rank === 'JOKER') return 0;
  if (card.rank === 'A') return 1;
  if (card.rank === 'J') return 11;
  if (card.rank === 'Q') return 12;
  if (card.rank === 'K') return isRed(card) ? -1 : 13;
  return Number(card.rank);
}

function cardPower(card) {
  switch (card.rank) {
    case '7': case '8': return 'peekOwn';
    case '9': case '10': return 'peekOther';
    case 'J': case 'Q': return 'swap';
    case 'K': return isRed(card) ? null : 'lookSwap';
    default: return null;
  }
}

function buildDeck() {
  const deck = [];
  let id = 0;
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push({ id: id++, rank, suit });
  }
  deck.push({ id: id++, rank: 'JOKER', suit: null });
  deck.push({ id: id++, rank: 'JOKER', suit: null });
  return deck;
}

function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function cardLabel(card) {
  if (!card) return '?';
  if (card.rank === 'JOKER') return 'Joker';
  const suit = { S: '♠', H: '♥', D: '♦', C: '♣' }[card.suit];
  return card.rank + suit;
}

class GameError extends Error {}

class Game {
  /**
   * @param {{id:string,name:string}[]} players in seating order
   * @param {{rng?:()=>number, deck?:object[]}} opts deck is for tests (top = last)
   */
  constructor(players, opts = {}) {
    if (players.length < MIN_PLAYERS) throw new GameError(`Need at least ${MIN_PLAYERS} players`);
    this.handSize = opts.handSize || HAND_SIZE;
    if (!HAND_SIZES.includes(this.handSize)) throw new GameError('Hands can be 4 or 6 cards');
    this.peekSlots = PEEK_SLOTS[this.handSize];
    const maxPlayers = MAX_PLAYERS_BY_HAND[this.handSize];
    if (players.length > maxPlayers) {
      throw new GameError(`At most ${maxPlayers} players with ${this.handSize} cards each`);
    }
    this.rng = opts.rng || Math.random;
    this.now = opts.now || Date.now;
    this.closingUntil = null;
    // Turn timer (ms, 0 = off). It also sets how long the final sticking window lasts.
    this.turnMs = opts.turnMs || 0;
    this.turnDeadline = null;
    this.pauseStart = null; // set while everyone waits for a sticker to give a card
    this.doneSticking = new Set(); // no-timer games: who pressed "No more sticks"
    this.mode = MODES.includes(opts.mode) ? opts.mode : 'normal';
    this.known = new Map(); // playerId -> Set of card objects that player has seen (easy mode)
    this.notes = new Map(); // playerId -> Map card object -> {is:[], not:[]} (hard mode)
    this.deck = opts.deck ? opts.deck.slice() : shuffle(buildDeck(), this.rng);
    this.discard = [];
    this.players = players.map((p) => ({
      id: p.id,
      name: p.name,
      hand: [],
      connected: true,
      ready: false,
    }));
    for (let i = 0; i < this.handSize; i++) {
      for (const p of this.players) p.hand.push(this.deck.pop());
    }
    this.phase = 'peek'; // peek -> play -> ended
    this.turn = 0;
    this.stage = 'draw'; // draw -> hold -> (power) -> next turn
    this.drawn = null;
    this.drawnFrom = null;
    this.power = null; // {type, step, revealed}
    this.cambioBy = null;
    this.turnsLeft = null;
    this.pendingGive = {}; // stickerId -> {to, slot}: owes a card after sticking someone else's
    this.results = null;
    this.log = [];
    this.seq = 0; // bumps on every change, handy for clients
    this.fx = []; // animation events for the latest action (see view())
    this.fxSeq = 0;
    this.awaiting = new Set(); // players the peek phase waits for (matchmade rooms)
    for (const p of this.players) {
      this.known.set(p.id, new Set(this.peekSlots.map((i) => p.hand[i]).filter(Boolean)));
      this.notes.set(p.id, new Map());
    }
    this.addLog(`Everyone peeks at their bottom ${this.peekSlots.length === 3 ? 'three' : 'two'} cards.`);
  }

  // ---------- helpers ----------
  // Easy mode: remember that a player has seen a card (it follows the card wherever it moves).
  learn(pid, card) {
    if (!card) return;
    const set = this.known.get(pid);
    if (set) set.add(card);
  }

  learnAll(card) {
    for (const p of this.players) this.learn(p.id, card);
  }

  // Cards shuffled back into the deck are unknown again.
  forget(cards) {
    for (const set of this.known.values()) for (const c of cards) set.delete(c);
    for (const m of this.notes.values()) for (const c of cards) m.delete(c);
  }

  addLog(text) {
    this.log.push({ n: this.log.length, text });
    if (this.log.length > 200) this.log.shift();
  }

  player(id) {
    const p = this.players.find((x) => x.id === id);
    if (!p) throw new GameError('You are not in this game');
    return p;
  }

  current() {
    return this.players[this.turn];
  }

  name(id) {
    return this.player(id).name;
  }

  cardAt(pid, slot) {
    const p = this.player(pid);
    if (!Number.isInteger(slot) || slot < 0 || slot >= p.hand.length || !p.hand[slot]) {
      throw new GameError('There is no card there');
    }
    return p.hand[slot];
  }

  drawFromDeck() {
    if (this.deck.length === 0) {
      // Reshuffle the discard pile, keeping the top card.
      const top = this.discard.pop();
      this.deck = shuffle(this.discard, this.rng);
      this.forget(this.deck);
      this.discard = top ? [top] : [];
      this.addLog('The deck ran out, so the discard pile was shuffled into a new deck.');
    }
    return this.deck.pop() || null;
  }

  discardCard(card) {
    this.discard.push(card);
  }

  // Animation events. Places: {zone:'deck'|'drawn'|'discard'} or {pid, slot}.
  // card: shown to everyone during the animation, or null to show a card back.
  move(from, to, card = null) {
    this.fx.push({ kind: 'move', from, to, card });
  }

  // ---------- actions ----------
  act(pid, action) {
    if (!action || typeof action.type !== 'string') throw new GameError('Bad action');
    const handler = {
      ready: this.ready,
      draw_deck: this.drawDeck,
      swap: this.swapDrawn,
      discard: this.discardDrawn,
      power_pick: this.powerPick,
      skip_power: this.skipPower,
      call_cambio: this.callCambio,
      stick: this.stick,
      give: this.give,
      done_sticking: this.doneStick,
      note: this.setNote,
    }[action.type];
    if (!handler) throw new GameError('Unknown action');
    // Everything pauses while someone owes a card after sticking.
    const owing = Object.keys(this.pendingGive);
    if (owing.length && action.type !== 'note' && !(action.type === 'give' && this.pendingGive[pid])) {
      throw new GameError(`Wait for ${this.name(owing[0])} to give a card`);
    }
    this.fx = [];
    const out = handler.call(this, pid, action) || {};
    this.seq++;
    if (this.fx.length) this.fxSeq++;
    return { reveals: out.reveals || [] };
  }

  ready(pid) {
    if (this.phase !== 'peek') throw new GameError('Not in the peek phase');
    this.player(pid).ready = true;
    this.maybeStartPlay();
  }

  maybeStartPlay() {
    if (this.phase !== 'peek' || this.awaiting.size) return;
    if (this.players.every((p) => p.ready || !p.connected)) {
      this.phase = 'play';
      this.turn = 0;
      this.skipDisconnected();
      this.addLog(`Game on! ${this.current().name} goes first.`);
      this.startTurnClock();
    }
  }

  requireTurn(pid, stage) {
    if (this.phase !== 'play') throw new GameError('The game is not in play');
    if (this.current().id !== pid) throw new GameError("It's not your turn");
    if (stage && this.stage !== stage) throw new GameError('You cannot do that right now');
  }

  drawDeck(pid) {
    this.requireTurn(pid, 'draw');
    const card = this.drawFromDeck();
    if (!card) throw new GameError('No cards left to draw');
    this.drawn = card;
    this.drawnFrom = 'deck';
    this.stage = 'hold';
    this.learn(pid, card);
    this.startTurnClock(); // every action restarts the turn timer
    this.move({ zone: 'deck' }, { zone: 'drawn' });
    this.addLog(`${this.name(pid)} drew from the deck.`);
  }

  swapDrawn(pid, { slot }) {
    this.requireTurn(pid, 'hold');
    const p = this.player(pid);
    const old = this.cardAt(pid, slot);
    p.hand[slot] = this.drawn;
    this.drawn = null;
    this.discardCard(old);
    this.move({ zone: 'drawn' }, { pid, slot });
    this.move({ pid, slot }, { zone: 'discard' }, old);
    this.addLog(`${p.name} swapped it into their hand and discarded the ${cardLabel(old)}.`);
    this.endTurn();
  }

  discardDrawn(pid) {
    this.requireTurn(pid, 'hold');
    const card = this.drawn;
    this.drawn = null;
    this.discardCard(card);
    this.move({ zone: 'drawn' }, { zone: 'discard' }, card);
    const power = cardPower(card);
    this.addLog(`${this.name(pid)} discarded the ${cardLabel(card)}.`);
    if (power) {
      this.stage = 'power';
      this.power = { type: power, step: power === 'lookSwap' ? 'look' : 'pick', revealed: null };
      this.startTurnClock(); // every action restarts the turn timer
    } else {
      this.endTurn();
    }
  }

  checkTargets(pid, targets, count) {
    if (!Array.isArray(targets) || targets.length !== count) {
      throw new GameError(`Pick ${count} card${count > 1 ? 's' : ''}`);
    }
    for (const t of targets) this.cardAt(t && t.pid, t && t.slot);
    if (count === 2 && targets[0].pid === targets[1].pid && targets[0].slot === targets[1].slot) {
      throw new GameError('Pick two different cards');
    }
  }

  swapCards(a, b) {
    const pa = this.player(a.pid);
    const pb = this.player(b.pid);
    [pa.hand[a.slot], pb.hand[b.slot]] = [pb.hand[b.slot], pa.hand[a.slot]];
  }

  describeTarget(pid, t) {
    const owner = t.pid === pid ? 'their own' : `${this.name(t.pid)}'s`;
    return `${owner} card #${t.slot + 1}`;
  }

  powerPick(pid, { targets }) {
    this.requireTurn(pid, 'power');
    const pw = this.power;
    const reveal = (ts) => {
      ts.forEach((t) => this.learn(pid, this.cardAt(t.pid, t.slot)));
      return revealList(ts);
    };
    const revealList = (ts) => [{
      to: pid,
      cards: ts.map((t) => ({ pid: t.pid, slot: t.slot, card: this.cardAt(t.pid, t.slot) })),
    }];

    if (pw.type === 'peekOwn') {
      this.checkTargets(pid, targets, 1);
      if (targets[0].pid !== pid) throw new GameError('Pick one of your own cards');
      this.fx.push({ kind: 'peek', at: targets.map((t) => ({ pid: t.pid, slot: t.slot })) });
      this.addLog(`${this.name(pid)} looked at ${this.describeTarget(pid, targets[0])}.`);
      const reveals = reveal(targets);
      this.endTurn();
      return { reveals };
    }

    if (pw.type === 'peekOther') {
      this.checkTargets(pid, targets, 1);
      if (targets[0].pid === pid) throw new GameError("Pick another player's card");
      this.fx.push({ kind: 'peek', at: targets.map((t) => ({ pid: t.pid, slot: t.slot })) });
      this.addLog(`${this.name(pid)} looked at ${this.describeTarget(pid, targets[0])}.`);
      const reveals = reveal(targets);
      this.endTurn();
      return { reveals };
    }

    if (pw.type === 'swap' || (pw.type === 'lookSwap' && pw.step === 'swap')) {
      this.checkTargets(pid, targets, 2);
      this.swapCards(targets[0], targets[1]);
      const [a, b] = targets.map((t) => ({ pid: t.pid, slot: t.slot }));
      this.move(a, b);
      this.move(b, a);
      this.addLog(`${this.name(pid)} swapped ${this.describeTarget(pid, targets[0])} with ${this.describeTarget(pid, targets[1])}.`);
      this.endTurn();
      return {};
    }

    if (pw.type === 'lookSwap' && pw.step === 'look') {
      this.checkTargets(pid, targets, 2);
      this.fx.push({ kind: 'peek', at: targets.map((t) => ({ pid: t.pid, slot: t.slot })) });
      this.addLog(`${this.name(pid)} looked at ${this.describeTarget(pid, targets[0])} and ${this.describeTarget(pid, targets[1])}.`);
      const reveals = reveal(targets);
      pw.step = 'swap';
      pw.revealed = reveals[0].cards;
      this.startTurnClock();
      return { reveals };
    }

    throw new GameError('You cannot do that right now');
  }

  skipPower(pid) {
    this.requireTurn(pid, 'power');
    this.addLog(`${this.name(pid)} skipped their power.`);
    this.endTurn();
  }

  callCambio(pid) {
    this.requireTurn(pid, 'draw');
    if (this.cambioBy) throw new GameError('Cambrio has already been called');
    this.cambioBy = pid;
    this.turnsLeft = this.players.length - 1;
    this.addLog(`${this.name(pid)} called CAMBRIO! Everyone else gets one more turn.`);
    this.endTurn();
  }

  stick(pid, { slot, target }) {
    if (this.phase !== 'play') throw new GameError('The game is not in play');
    const t = target || { pid, slot };
    const p = this.player(pid);
    if (this.pendingGive[pid]) throw new GameError('Give a card first');
    const owner = this.player(t.pid);
    const card = this.cardAt(t.pid, t.slot);
    const top = this.discard[this.discard.length - 1];
    if (!top) throw new GameError('There is nothing to stick on');
    const whose = owner.id === pid ? 'their' : `${owner.name}'s`;
    if (card.rank === top.rank) {
      owner.hand[t.slot] = null;
      this.discardCard(card);
      this.fx.push({ kind: 'stick', by: pid, at: { pid: t.pid, slot: t.slot }, card, ok: true });
      this.addLog(`${p.name} stuck ${whose} ${cardLabel(card)} on the pile!`);
      if (owner.id !== pid && p.hand.some(Boolean)) {
        this.pendingGive[pid] = { to: owner.id, slot: t.slot };
        if (this.pauseStart === null) this.pauseStart = this.now();
        this.addLog(`${p.name} now gives ${owner.name} one of their cards.`);
      }
      return {};
    }
    // Wrong: the card goes back where it was and the sticker takes a penalty card.
    const penalty = this.drawFromDeck();
    this.learnAll(card); // it was shown to the whole table before going back
    this.fx.push({ kind: 'stick', by: pid, at: { pid: t.pid, slot: t.slot }, card, ok: false });
    if (penalty) {
      p.hand.push(penalty);
      this.move({ zone: 'deck' }, { pid, slot: p.hand.length - 1 });
    }
    this.addLog(`${p.name} tried to stick ${whose} ${cardLabel(card)} on a ${cardLabel(top)}. Wrong! The card goes back and ${p.name} takes a penalty card.`);
    return {};
  }

  // Hard mode: mark what a card is or isn't. note = {is:[ranks], not:[ranks]}; empty clears it.
  setNote(pid, { target, note }) {
    if (this.mode !== 'hard') throw new GameError('Notes are only in hard mode');
    if (this.phase === 'ended') throw new GameError('The game is over');
    if (!this.known.has(pid)) throw new GameError('You are not in this game');
    const card = this.cardAt(target && target.pid, target && target.slot);
    const clean = (list) => [...new Set(Array.isArray(list) ? list : [])].filter((r) => NOTE_RANKS.includes(r));
    const is = clean(note && note.is);
    const not = clean(note && note.not).filter((r) => !is.includes(r));
    const notes = this.notes.get(pid);
    if (is.length || not.length) notes.set(card, { is, not });
    else notes.delete(card);
    return {};
  }

  give(pid, { slot }) {
    if (this.phase !== 'play') throw new GameError('The game is not in play');
    const owed = this.pendingGive[pid];
    if (!owed) throw new GameError("You don't owe anyone a card");
    const p = this.player(pid);
    const card = this.cardAt(pid, slot);
    const to = this.player(owed.to);
    p.hand[slot] = null;
    let toSlot = owed.slot;
    if (owed.slot < to.hand.length && !to.hand[owed.slot]) to.hand[owed.slot] = card;
    else { to.hand.push(card); toSlot = to.hand.length - 1; }
    this.move({ pid, slot }, { pid: to.id, slot: toSlot });
    delete this.pendingGive[pid];
    this.addLog(`${p.name} gave their card #${slot + 1} to ${to.name}.`);
    if (!Object.keys(this.pendingGive).length) this.endPause();
    if (this.stage === 'closing') this.tryFinish();
    return {};
  }

  // ---------- turn flow ----------
  endTurn() {
    this.drawn = null;
    this.drawnFrom = null;
    this.power = null;
    this.stage = 'draw';
    if (this.cambioBy && this.turnsLeft !== null) {
      if (this.current().id !== this.cambioBy) this.turnsLeft--;
      if (this.turnsLeft <= 0) return this.startClosing();
    }
    this.turn = (this.turn + 1) % this.players.length;
    this.skipDisconnected();
    if (this.phase === 'play' && this.stage !== 'closing') this.startTurnClock();
  }

  startTurnClock() {
    this.turnDeadline = this.turnMs ? this.now() + this.turnMs : null;
  }

  /** Timers stop while the table waits for a give; push the deadlines back by the pause. */
  endPause() {
    if (this.pauseStart === null) return;
    const d = this.now() - this.pauseStart;
    if (this.turnDeadline) this.turnDeadline += d;
    if (this.closingUntil) this.closingUntil += d;
    this.pauseStart = null;
  }

  /** Called by the server when the turn timer may have run out. Returns true if a turn was skipped. */
  checkTurnTimeout() {
    if (this.phase !== 'play' || this.stage === 'closing' || !this.turnDeadline) return false;
    if (this.pauseStart !== null || this.now() < this.turnDeadline) return false;
    const p = this.current();
    this.fx = [];
    if (this.stage === 'hold' && this.drawn) {
      this.discardCard(this.drawn);
      this.move({ zone: 'drawn' }, { zone: 'discard' }, this.drawn);
      this.addLog(`${p.name} ran out of time, so their card was discarded.`);
    } else if (this.stage === 'power') {
      this.addLog(`${p.name} ran out of time to use their power.`);
    } else {
      this.addLog(`${p.name} ran out of time, so their turn was skipped.`);
    }
    this.endTurn();
    this.seq++;
    if (this.fx.length) this.fxSeq++;
    return true;
  }

  skipDisconnected() {
    for (let i = 0; i < this.players.length; i++) {
      const p = this.current();
      if (p.connected) return;
      if (this.cambioBy) {
        if (p.id === this.cambioBy) return this.startClosing();
        this.turnsLeft--;
        if (this.turnsLeft <= 0) return this.startClosing();
      }
      this.addLog(`${p.name} is away, so their turn was skipped.`);
      this.turn = (this.turn + 1) % this.players.length;
    }
  }

  setConnected(pid, connected) {
    const p = this.players.find((x) => x.id === pid);
    if (!p) return;
    p.connected = connected;
    if (connected) this.awaiting.delete(pid);
    if (this.phase === 'peek') this.maybeStartPlay();
    this.seq++;
  }

  stopAwaiting() {
    this.awaiting.clear();
    this.maybeStartPlay();
    this.seq++;
  }

  /** Called by the server when a player has been away too long on their turn. */
  forfeitTurn(pid) {
    if (this.phase !== 'play' || this.stage === 'closing' || this.current().id !== pid) return false;
    this.fx = [];
    if (this.drawn) {
      this.discardCard(this.drawn);
      this.move({ zone: 'drawn' }, { zone: 'discard' }, this.drawn);
      this.fxSeq++;
    }
    this.addLog(`${this.name(pid)} timed out, so their turn was skipped.`);
    this.endTurn();
    this.seq++;
    return true;
  }

  removePlayer(pid) {
    // Used when a player leaves for good. Their cards leave play.
    const idx = this.players.findIndex((x) => x.id === pid);
    if (idx === -1) return;
    const wasCurrent = idx === this.turn && this.phase === 'play';
    if (wasCurrent && this.drawn) this.discardCard(this.drawn);
    delete this.pendingGive[pid];
    for (const [k, v] of Object.entries(this.pendingGive)) if (v.to === pid) delete this.pendingGive[k];
    const leaver = this.players[idx];
    this.players.splice(idx, 1);
    this.addLog(`${leaver.name} left the game.`);
    if (this.phase === 'ended') return;
    if (this.players.length < MIN_PLAYERS) {
      this.addLog('Not enough players left to keep playing.');
      return this.finish();
    }
    if (this.cambioBy === pid) {
      this.addLog('The Cambrio caller left, so the game ends now.');
      return this.finish();
    }
    if (idx < this.turn) this.turn--;
    if (this.turn >= this.players.length) this.turn = 0;
    if (wasCurrent) {
      this.drawn = null; this.drawnFrom = null; this.power = null; this.stage = 'draw';
      this.startTurnClock();
      if (this.cambioBy) {
        this.turnsLeft--;
        if (this.turnsLeft <= 0) return this.startClosing();
      }
    } else if (this.cambioBy) {
      // Recount: remaining turns can't exceed players still to go.
      this.turnsLeft = Math.min(this.turnsLeft, this.players.length - 1);
    }
    if (this.phase === 'peek') this.maybeStartPlay();
    else this.skipDisconnected();
    this.seq++;
  }

  /** The final turn is over: give everyone a few seconds to stick, then score. */
  startClosing() {
    this.stage = 'closing';
    this.drawn = null;
    this.power = null;
    this.turnDeadline = null;
    this.doneSticking = new Set();
    if (this.turnMs) {
      this.closingUntil = this.now() + this.turnMs;
      this.addLog(`Last chance to stick! Cards are revealed in ${this.turnMs / 1000} seconds.`);
    } else {
      this.closingUntil = null;
      this.addLog('Last chance to stick! Cards are revealed once everyone presses "No more sticks".');
    }
  }

  doneStick(pid) {
    if (this.phase !== 'play' || this.stage !== 'closing') throw new GameError('You can only do that at the very end');
    this.player(pid);
    if (this.doneSticking.has(pid)) return {};
    this.doneSticking.add(pid);
    this.addLog(`${this.name(pid)} has no more sticks.`);
    this.tryFinish();
    return {};
  }

  /** Called by the server when the sticking window may be over. Returns true if the game ended. */
  tryFinish() {
    if (this.phase !== 'play' || this.stage !== 'closing') return false;
    if (Object.keys(this.pendingGive).length) return false; // wait for the give
    if (this.closingUntil !== null) {
      if (this.now() < this.closingUntil) return false;
    } else if (!this.players.every((p) => this.doneSticking.has(p.id) || !p.connected)) {
      return false;
    }
    this.finish();
    this.seq++;
    return true;
  }

  /** Called by the server when a sticker takes too long to give a card. */
  autoGive(pid) {
    const owed = this.pendingGive[pid];
    if (!owed || this.phase !== 'play') return false;
    const p = this.player(pid);
    const slots = p.hand.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
    if (!slots.length) { delete this.pendingGive[pid]; this.seq++; return true; }
    const slot = slots[Math.floor(this.rng() * slots.length)];
    this.fx = [];
    this.give(pid, { slot });
    this.addLog(`${p.name} took too long, so a random card was given.`);
    this.seq++;
    this.fxSeq++;
    return true;
  }

  finish() {
    this.phase = 'ended';
    this.stage = null;
    this.drawn = null;
    this.power = null;
    this.pendingGive = {};
    const scores = this.players.map((p) => {
      const vals = p.hand.filter(Boolean).map(cardValue);
      return {
        id: p.id,
        name: p.name,
        score: vals.reduce((s, v) => s + v, 0),
        lowest: vals.length ? Math.min(...vals) : null,
      };
    });
    const best = Math.min(...scores.map((s) => s.score));
    let tied = scores.filter((s) => s.score === best);
    let tieBreak = null;
    if (tied.length > 1) {
      if (this.cambioBy && tied.some((s) => s.id === this.cambioBy)) {
        // The Cambrio caller wins ties.
        tied = tied.filter((s) => s.id === this.cambioBy);
        tieBreak = 'cambio';
      } else {
        // Otherwise the lowest single card wins. No cards left counts as lowest.
        const low = (s) => (s.lowest === null ? -Infinity : s.lowest);
        const lowest = Math.min(...tied.map(low));
        tied = tied.filter((s) => low(s) === lowest);
        tieBreak = 'lowestCard';
      }
    }
    const winners = tied.map((s) => s.id);
    this.results = { scores, winners, tieBreak };
    const names = winners.map((id) => this.name(id)).join(' & ');
    this.addLog(`Game over! ${names} win${winners.length === 1 ? 's' : ''} with ${best} point${best === 1 ? '' : 's'}.`);
  }

  // Hard mode: how many of each card are not in the discard pile (still in the deck or in hands).
  unplayedCounts() {
    const counts = {};
    const add = (c) => {
      if (!c) return;
      const k = c.rank === 'K' ? (isRed(c) ? 'K-red' : 'K-black') : c.rank;
      counts[k] = (counts[k] || 0) + 1;
    };
    this.deck.forEach(add);
    this.players.forEach((p) => p.hand.forEach(add));
    add(this.drawn);
    return counts;
  }

  // ---------- per-player view ----------
  view(pid) {
    const ended = this.phase === 'ended';
    const cur = this.phase === 'play' && this.stage !== 'closing' ? this.current() : null;
    const me = this.players.find((p) => p.id === pid);
    const knownByMe = this.known.get(pid);
    const notesByMe = this.mode === 'hard' ? this.notes.get(pid) : null;
    return {
      mode: this.mode,
      unplayed: this.mode === 'hard' && !ended ? this.unplayedCounts() : null,
      seq: this.seq,
      handSize: this.handSize,
      peekCount: this.peekSlots.length,
      phase: this.phase,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        ready: p.ready,
        slots: p.hand.map((c, i) => {
          if (!c) return null;
          if (ended) return c;
          if (this.phase === 'peek' && p.id === pid && this.peekSlots.includes(i)) return c;
          if (this.mode === 'easy' && this.phase === 'play' && knownByMe && knownByMe.has(c)) return { ...c, known: true };
          const note = notesByMe && notesByMe.get(c);
          return note ? { hidden: true, note } : { hidden: true };
        }),
      })),
      current: cur ? cur.id : null,
      stage: this.stage,
      deckCount: this.deck.length,
      discardTop: this.discard[this.discard.length - 1] || null,
      discardUnder: this.discard[this.discard.length - 2] || null,
      fx: { seq: this.fxSeq, events: this.fx },
      discardCount: this.discard.length,
      pendingGive: this.pendingGive[pid] || null,
      owing: Object.keys(this.pendingGive),
      drawn: this.drawn ? (cur && cur.id === pid ? this.drawn : { hidden: true }) : null,
      drawnFrom: this.drawnFrom,
      power: this.power ? {
        type: this.power.type,
        step: this.power.step,
        revealed: cur && cur.id === pid ? this.power.revealed : null,
      } : null,
      cambioBy: this.cambioBy,
      turnsLeft: this.turnsLeft,
      closingMsLeft: this.stage === 'closing' && this.closingUntil !== null
        ? Math.max(0, this.closingUntil - (this.pauseStart ?? this.now())) : null,
      turnMs: this.turnMs,
      turnMsLeft: this.turnDeadline && this.stage !== 'closing'
        ? Math.max(0, this.turnDeadline - (this.pauseStart ?? this.now())) : null,
      paused: this.pauseStart !== null,
      doneSticking: [...this.doneSticking],
      results: this.results,
      log: this.log.slice(-40),
      youAreIn: !!me,
    };
  }
}

module.exports = {
  Game, GameError, buildDeck, cardValue, cardPower, cardLabel,
  TURN_TIMER_CHOICES, GIVE_TIMEOUT_MS, MODES, NOTE_RANKS, HAND_SIZE, HAND_SIZES, MIN_PLAYERS, MAX_PLAYERS, MAX_PLAYERS_BY_HAND, INITIAL_PEEK_SLOTS, PEEK_SLOTS,
};
