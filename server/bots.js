'use strict';
// Simple computer players for private rooms. A bot only uses what it has really
// seen (the game's per-player knowledge), so it plays fair.

const { cardValue, cardPower } = require('./game');

const UNKNOWN = 6.5; // what an unseen card is worth on average, roughly

function knows(game, botId, card) {
  const set = game.known.get(botId);
  return !!(set && card && set.has(card));
}

/** The bot's guess at each of its own cards: the real value if seen, else an average. */
function ownGuesses(game, bot) {
  return bot.hand.map((c, slot) => (c ? { slot, card: c, known: knows(game, bot.id, c), value: knows(game, bot.id, c) ? cardValue(c) : UNKNOWN } : null)).filter(Boolean);
}

function pickRandom(game, list) {
  return list[Math.floor(game.rng() * list.length)];
}

/** A stick the bot is sure about: a card it has seen that matches the top of the pile. */
function stickMove(game, bot) {
  const top = game.discard[game.discard.length - 1];
  if (!top) return null;
  for (const g of ownGuesses(game, bot)) {
    if (g.known && g.card.rank === top.rank) return { type: 'stick', slot: g.slot };
  }
  // Someone else's card it has seen, as long as it has a card to give back.
  if (bot.hand.some(Boolean)) {
    for (const p of game.players) {
      if (p.id === bot.id) continue;
      const slot = p.hand.findIndex((c) => c && c.rank === top.rank && knows(game, bot.id, c));
      if (slot >= 0) return { type: 'stick', target: { pid: p.id, slot } };
    }
  }
  return null;
}

function powerMove(game, bot) {
  const pw = game.power;
  const mine = ownGuesses(game, bot);
  const others = game.players.filter((p) => p.id !== bot.id);
  const otherCards = others.flatMap((p) => p.hand.map((c, slot) => (c ? { pid: p.id, slot, card: c, known: knows(game, bot.id, c) } : null)).filter(Boolean));
  if (pw.type === 'peekOwn') {
    const unseen = mine.filter((g) => !g.known);
    return unseen.length ? { type: 'power_pick', targets: [{ pid: bot.id, slot: pickRandom(game, unseen).slot }] } : { type: 'skip_power' };
  }
  if (pw.type === 'peekOther') {
    const unseen = otherCards.filter((o) => !o.known);
    const t = pickRandom(game, unseen.length ? unseen : otherCards);
    return t ? { type: 'power_pick', targets: [{ pid: t.pid, slot: t.slot }] } : { type: 'skip_power' };
  }
  // Swaps: trade the bot's worst card for the lowest card it knows about elsewhere.
  const worst = mine.slice().sort((a, b) => b.value - a.value)[0];
  if (pw.type === 'swap') {
    const best = otherCards.filter((o) => o.known).sort((a, b) => cardValue(a.card) - cardValue(b.card))[0];
    if (worst && best && cardValue(best.card) < worst.value - 1) {
      return { type: 'power_pick', targets: [{ pid: bot.id, slot: worst.slot }, { pid: best.pid, slot: best.slot }] };
    }
    return { type: 'skip_power' };
  }
  if (pw.type === 'lookSwap' && pw.step === 'look') {
    const own = mine.find((g) => !g.known) || worst;
    const other = otherCards.find((o) => !o.known) || otherCards[0];
    if (!own || !other) return { type: 'skip_power' };
    return { type: 'power_pick', targets: [{ pid: bot.id, slot: own.slot }, { pid: other.pid, slot: other.slot }] };
  }
  if (pw.type === 'lookSwap' && pw.step === 'swap') {
    const seen = pw.revealed || [];
    const a = seen.find((x) => x.pid === bot.id);
    const b = seen.find((x) => x.pid !== bot.id);
    if (a && b && cardValue(b.card) < cardValue(a.card)) {
      return { type: 'power_pick', targets: [{ pid: a.pid, slot: a.slot }, { pid: b.pid, slot: b.slot }] };
    }
    return { type: 'skip_power' };
  }
  return { type: 'skip_power' };
}

/** What this bot wants to do right now, or null to wait. */
function decide(game, botId) {
  const bot = game.players.find((p) => p.id === botId);
  if (!bot) return null;
  if (game.phase === 'peek') return bot.ready ? null : { type: 'ready' };
  if (game.phase !== 'play') return null;

  // Owes a card after sticking someone else's: give away the worst one.
  if (game.pendingGive[botId]) {
    const worst = ownGuesses(game, bot).sort((a, b) => b.value - a.value)[0];
    return worst ? { type: 'give', slot: worst.slot } : null;
  }
  if (Object.keys(game.pendingGive).length) return null; // the table is paused

  const stick = stickMove(game, bot);
  if (stick) return stick;

  if (game.stage === 'closing') return game.doneSticking.has(botId) ? null : { type: 'done_sticking' };
  if (game.current().id !== botId) return null;

  if (game.stage === 'draw') {
    const mine = ownGuesses(game, bot);
    const total = mine.reduce((s, g) => s + g.value, 0);
    const allKnown = mine.every((g) => g.known);
    if (!game.cambioBy && ((allKnown && total <= 6) || total <= 4)) return { type: 'call_cambio' };
    return { type: 'draw_deck' };
  }
  if (game.stage === 'hold') {
    const v = cardValue(game.drawn);
    const worst = ownGuesses(game, bot).sort((a, b) => b.value - a.value)[0];
    // Keep a low card; otherwise discard it (and use its power, if any).
    if (worst && v < worst.value && !(cardPower(game.drawn) && v >= 7)) return { type: 'swap', slot: worst.slot };
    return { type: 'discard' };
  }
  if (game.stage === 'power') return powerMove(game, bot);
  return null;
}

module.exports = { decide };
