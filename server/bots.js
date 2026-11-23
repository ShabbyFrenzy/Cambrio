'use strict';
// Computer players. A bot only uses what a careful human at the table could know:
// cards it has seen (the game's per-player knowledge, which follows cards when they
// are swapped in front of everyone) and the public discard pile. It counts cards to
// guess what an unseen card is worth.
//
// The numbers in DEFAULT_PARAMS were tuned by self-play: scripts/train-bots.js plays
// thousands of simulated games and keeps the settings that win most often.

const { Game, cardValue, cardPower, buildDeck } = require('./game');

const DEFAULT_PARAMS = require('./bot-params.json');

const FULL_DECK_VALUES = buildDeck().map(cardValue);

function knows(game, botId, card) {
  const set = game.known.get(botId);
  return !!(set && card && set.has(card));
}

/** Average value of the cards this bot has not seen anywhere (card counting). */
function unseenAverage(game, botId) {
  const pool = FULL_DECK_VALUES.slice();
  const remove = (c) => {
    const i = pool.indexOf(cardValue(c));
    if (i >= 0) pool.splice(i, 1);
  };
  for (const c of game.discard) remove(c);
  for (const p of game.players) for (const c of p.hand) if (c && knows(game, botId, c)) remove(c);
  if (game.drawn && knows(game, botId, game.drawn)) remove(game.drawn);
  return pool.length ? pool.reduce((s, v) => s + v, 0) / pool.length : 6;
}

/** Every card in a player's hand with what the bot believes it is worth. */
function guesses(game, botId, player, avg) {
  return player.hand.map((c, slot) => {
    if (!c) return null;
    const known = knows(game, botId, c);
    return { pid: player.id, slot, card: c, known, value: known ? cardValue(c) : avg };
  }).filter(Boolean);
}

const sum = (list) => list.reduce((s, g) => s + g.value, 0);
const worstOf = (list) => list.slice().sort((a, b) => b.value - a.value || a.known - b.known)[0];
const pickRandom = (game, list) => list[Math.floor(game.rng() * list.length)];

function context(game, bot, params) {
  const avg = unseenAverage(game, bot.id);
  const mine = guesses(game, bot.id, bot, avg);
  const others = game.players.filter((p) => p.id !== bot.id).map((p) => {
    const cards = guesses(game, bot.id, p, avg);
    return { p, cards, total: sum(cards) + params.oppUnknownBias * cards.filter((c) => !c.known).length };
  });
  return { avg, mine, others, P: params };
}

/** A stick the bot is sure about: a seen card that matches the top of the pile. */
function stickMove(game, bot, ctx) {
  const top = game.discard[game.discard.length - 1];
  if (!top) return null;
  const own = ctx.mine.find((g) => g.known && g.card.rank === top.rank);
  if (own) return { type: 'stick', slot: own.slot };
  // Sticking someone else's card costs nothing but your worst card, which you hand over.
  if (ctx.P.stickOthers && bot.hand.some(Boolean)) {
    for (const o of ctx.others) {
      const hit = o.cards.find((g) => g.known && g.card.rank === top.rank);
      if (hit) return { type: 'stick', target: { pid: hit.pid, slot: hit.slot } };
    }
  }
  return null;
}

function powerMove(game, bot, ctx) {
  const { mine, others, avg, P } = ctx;
  const pw = game.power;
  const skip = { type: 'skip_power' };
  const allOther = others.flatMap((o) => o.cards);
  // The opponent closest to winning is the one worth watching and stealing from.
  const leader = others.slice().sort((a, b) => a.total - b.total)[0];
  if (pw.type === 'peekOwn') {
    const unseen = mine.filter((g) => !g.known);
    return unseen.length ? { type: 'power_pick', targets: [{ pid: bot.id, slot: pickRandom(game, unseen).slot }] } : skip;
  }
  if (pw.type === 'peekOther') {
    const pool = (P.peekLeader && leader ? leader.cards : allOther).filter((g) => !g.known);
    const fallback = allOther.filter((g) => !g.known);
    const t = pickRandom(game, pool.length ? pool : fallback.length ? fallback : allOther);
    return t ? { type: 'power_pick', targets: [{ pid: t.pid, slot: t.slot }] } : skip;
  }
  const worst = worstOf(mine);
  if (pw.type === 'swap') {
    // Best trade: my worst card for the lowest card I know about elsewhere.
    const best = allOther.filter((g) => g.known).sort((a, b) => a.value - b.value)[0];
    if (worst && best && worst.value - best.value > P.swapGain) {
      return { type: 'power_pick', targets: [{ pid: bot.id, slot: worst.slot }, { pid: best.pid, slot: best.slot }] };
    }
    // Blind trade: dump a known high card on the leader for an unseen one.
    const blind = leader && pickRandom(game, leader.cards.filter((g) => !g.known));
    if (worst && worst.known && blind && worst.value - avg > P.blindGain) {
      return { type: 'power_pick', targets: [{ pid: bot.id, slot: worst.slot }, { pid: blind.pid, slot: blind.slot }] };
    }
    return skip;
  }
  if (pw.type === 'lookSwap' && pw.step === 'look') {
    const ownT = mine.find((g) => !g.known) || worst;
    const pool = (leader ? leader.cards : allOther);
    const otherT = pool.find((g) => !g.known) || pool[0] || allOther[0];
    if (!ownT || !otherT) return skip;
    return { type: 'power_pick', targets: [{ pid: bot.id, slot: ownT.slot }, { pid: otherT.pid, slot: otherT.slot }] };
  }
  if (pw.type === 'lookSwap' && pw.step === 'swap') {
    // Now everything just looked at is known: make the best trade available.
    const best = allOther.filter((g) => g.known).sort((a, b) => a.value - b.value)[0];
    if (worst && best && worst.value - best.value > P.swapGain) {
      return { type: 'power_pick', targets: [{ pid: bot.id, slot: worst.slot }, { pid: best.pid, slot: best.slot }] };
    }
    return skip;
  }
  return skip;
}

// ---------- look-ahead ----------
// For its big choices the bot imagines many possible futures: it deals the cards it
// hasn't seen into a random but consistent order, plays the rest of the round out
// with its normal habits for everyone, and picks the choice that wins most often.

function seeded(seed) {
  let x = seed % 2147483647 || 1;
  return () => ((x = (x * 16807) % 2147483647) - 1) / 2147483646;
}

/** A private copy of the game where the cards this bot hasn't seen are reshuffled. */
function imagine(game, botId, rng) {
  const g = Object.create(Game.prototype);
  Object.assign(g, game);
  const mine = game.known.get(botId);
  // Every place a card sits, and whether this bot has seen it.
  const spots = [];
  game.players.forEach((p, pi) => p.hand.forEach((c, slot) => { if (c) spots.push({ where: 'hand', pi, slot, c }); }));
  game.deck.forEach((c, i) => spots.push({ where: 'deck', i, c }));
  const hidden = spots.filter((sp) => !mine.has(sp.c));
  const cards = hidden.map((sp) => sp.c);
  for (let i = cards.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [cards[i], cards[j]] = [cards[j], cards[i]]; }
  const swapped = new Map(hidden.map((sp, i) => [sp.c, cards[i]])); // real card -> imagined card
  const map = (c) => (c && swapped.has(c) ? swapped.get(c) : c);
  g.players = game.players.map((p) => ({ ...p, hand: p.hand.map(map) }));
  g.deck = game.deck.map(map);
  g.discard = game.discard.slice();
  // Others remember the spot they saw, so they "know" whatever card is imagined there.
  g.known = new Map([...game.known].map(([id, set]) => [id, new Set([...set].map(map))]));
  g.notes = new Map();
  g.pendingGive = { ...game.pendingGive };
  g.power = game.power ? { ...game.power } : null;
  g.doneSticking = new Set(game.doneSticking);
  g.awaiting = new Set();
  g.log = []; g.history = null; g.fx = [];
  g.rng = rng;
  const t = game.now();
  g.now = () => t;
  g.turnMs = 0; g.turnDeadline = null; g.closingUntil = null; g.pauseStart = null;
  return g;
}

/** Plays an imagined game to the end with everyone using plain habits. Returns this bot's win share. */
function playOut(g, botId, params) {
  const ids = g.players.map((p) => p.id);
  const plain = { ...params, lookahead: 0 };
  for (let steps = 0; g.phase !== 'ended' && steps < 400; steps++) {
    let moved = false;
    const start = Math.floor(g.rng() * ids.length);
    for (let k = 0; k < ids.length && !moved; k++) {
      const id = ids[(start + k) % ids.length];
      const a = decide(g, id, plain);
      if (!a) continue;
      try { g.act(id, a); moved = true; } catch (e) { /* stale plan: try someone else */ }
    }
    if (!moved) {
      const fb = { draw: 'draw_deck', hold: 'discard', power: 'skip_power', closing: 'done_sticking' }[g.stage];
      const who = g.stage === 'closing' ? g.players.find((p) => !g.doneSticking.has(p.id)) : g.current();
      try { g.act(who.id, { type: fb }); } catch (e) { return 0; }
    }
  }
  if (g.phase !== 'ended') return 0;
  const w = g.results.winners;
  return w.includes(botId) ? 1 / w.length : 0;
}

/** Tries each choice in the same set of imagined futures and returns the best one. */
function bestByLookahead(game, botId, choices, params) {
  if (choices.length < 2) return choices[0];
  const n = params.lookahead;
  const score = choices.map(() => 0);
  const base = Math.floor(game.rng() * 1e9) + 1;
  const started = Date.now();
  // Stop early on big tables so the server never stalls (other rooms share it).
  for (let i = 0; i < n && (i < 6 || Date.now() - started < params.thinkMs); i++) {
    choices.forEach((a, ci) => {
      const rng = seeded(base + i * 7919); // same future for every choice, so only the choice differs
      const g = imagine(game, botId, rng);
      try { g.act(botId, a); } catch (e) { score[ci] -= n; return; }
      score[ci] += playOut(g, botId, params);
    });
  }
  let best = 0;
  score.forEach((v, i) => { if (v > score[best]) best = i; });
  return choices[best];
}

/** What this bot wants to do right now, or null to wait. */
function decide(game, botId, params = DEFAULT_PARAMS) {
  const bot = game.players.find((p) => p.id === botId);
  if (!bot) return null;
  if (game.phase === 'peek') return bot.ready ? null : { type: 'ready' };
  if (game.phase !== 'play') return null;
  const ctx = context(game, bot, params);
  const P = params;

  // Owes a card after sticking someone else's: hand over the worst one.
  if (game.pendingGive[botId]) {
    const worst = worstOf(ctx.mine);
    return worst ? { type: 'give', slot: worst.slot } : null;
  }
  if (Object.keys(game.pendingGive).length) return null; // the table is paused

  const stick = stickMove(game, bot, ctx);
  if (stick) return stick;

  if (game.stage === 'closing') return game.doneSticking.has(botId) ? null : { type: 'done_sticking' };
  if (game.current().id !== botId) return null;

  if (game.stage === 'draw') {
    // Call Cambrio when sure of a low hand, or when the guess (unseen cards count
    // as average, plus a safety margin) is low enough and ahead of everyone else.
    const unknown = ctx.mine.filter((g) => !g.known).length;
    const mineTotal = sum(ctx.mine) + P.ownUnknownRisk * unknown;
    const bestOpp = Math.min(...ctx.others.map((o) => o.total));
    const sure = unknown === 0 && mineTotal <= P.cambioKnownMax;
    const likely = mineTotal <= P.cambioMax && mineTotal < bestOpp - P.cambioLead;
    if (!game.cambioBy && (sure || likely)) return { type: 'call_cambio' };
    // Close calls: imagine how the round could go both ways.
    if (P.lookahead && !game.cambioBy && mineTotal <= P.cambioMax + P.lookRange) {
      return bestByLookahead(game, botId, [{ type: 'draw_deck' }, { type: 'call_cambio' }], P);
    }
    return { type: 'draw_deck' };
  }
  if (game.stage === 'hold') {
    const v = cardValue(game.drawn);
    const worst = worstOf(ctx.mine);
    // A power is worth something: discarding a power card means using it.
    const powerBonus = cardPower(game.drawn) ? P.powerValue : 0;
    if (P.lookahead) {
      // Compare discarding with swapping into each of the two worst-looking cards.
      const options = [{ type: 'discard' }, ...ctx.mine.slice().sort((a, b) => b.value - a.value).slice(0, 2).map((g) => ({ type: 'swap', slot: g.slot }))];
      return bestByLookahead(game, botId, options, P);
    }
    if (worst && worst.value - v > P.keepMargin + powerBonus) return { type: 'swap', slot: worst.slot };
    return { type: 'discard' };
  }
  if (game.stage === 'power') return powerMove(game, bot, ctx);
  return null;
}

module.exports = { decide, DEFAULT_PARAMS, unseenAverage };
