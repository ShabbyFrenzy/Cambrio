'use strict';
// Self-play training for the Cambrio bot.
//   node scripts/train-bots.js [passes] [gamesPerTest]
// Starts from server/bot-params.json, tries changing one setting at a time, and keeps
// a change only when the changed bot beats the current one over many simulated
// 3-player games. Writes the winner back to server/bot-params.json.
// Takes a few minutes per pass.
const fs = require('fs');
const path = require('path');
const { Game } = require('../server/game');
const { decide } = require('../server/bots');

const PARAMS_FILE = path.join(__dirname, '..', 'server', 'bot-params.json');
const RANGES = {
  keepMargin: [-1, 4], powerValue: [0, 5], swapGain: [0, 6], blindGain: [0, 8],
  cambioMax: [-2, 14], cambioKnownMax: [0, 14], cambioLead: [-4, 8], ownUnknownRisk: [-2, 5], oppUnknownBias: [-3, 3],
};
const FLAGS = ['stickOthers', 'peekLeader'];

function rngFrom(seed) {
  let s = seed % 2147483647 || 1;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

/** Plays one game with no timers. brains[i] decides for seat i. Returns the winner seats. */
function playGame(brains, seed, handSize = 4) {
  const rng = rngFrom(seed);
  const ids = brains.map((_, i) => `p${i}`);
  const g = new Game(ids.map((id) => ({ id, name: id })), { rng, handSize });
  for (let steps = 0; g.phase !== 'ended' && steps < 4000; steps++) {
    // Everyone races to stick, so ask the seats in a random order each step.
    const order = ids.map((id, i) => [i, rng()]).sort((a, b) => a[1] - b[1]).map(([i]) => i);
    let moved = false;
    for (const i of order) {
      const a = brains[i](g, ids[i]);
      if (!a) continue;
      try { g.act(ids[i], a); moved = true; break; } catch (e) { /* try the next seat */ }
    }
    if (!moved) {
      // A bot's plan can go stale (say, its target card was just stuck): fall back like the server does.
      const fb = { draw: 'draw_deck', hold: 'discard', power: 'skip_power', closing: 'done_sticking' }[g.stage];
      const who = g.stage === 'closing' ? g.players.find((p) => !g.doneSticking.has(p.id)) : g.current();
      try { g.act(who.id, { type: fb }); } catch (e) { break; }
    }
    if (steps > 600 && g.stage === 'draw' && !g.cambioBy) g.act(g.current().id, { type: 'call_cambio' }); // stop endless games
  }
  if (g.phase !== 'ended') return [];
  return g.results.winners.map((id) => ids.indexOf(id));
}

/** Win share of `a` against copies of `b`, rotating seats. */
function match(a, b, games, seed0, players = 3) {
  let score = 0;
  for (let n = 0; n < games; n++) {
    const seat = n % players;
    const brains = Array.from({ length: players }, (_, i) => (i === seat ? a : b));
    const w = playGame(brains, seed0 + n, n % 4 === 3 ? 6 : 4);
    if (w.includes(seat)) score += 1 / w.length;
  }
  return score / games; // 1/players means evenly matched
}

// Training tunes the bot's quick habits (look-ahead off, so thousands of games run in
// seconds). In real games the bot also looks ahead, using these habits to imagine futures.
const brainOf = (params) => { const quick = { ...params, lookahead: 0 }; return (g, id) => decide(g, id, quick); };

/** Values to try for one setting, around its current value. */
function candidates(k, cur) {
  const [lo, hi] = RANGES[k];
  const step = (hi - lo) / 10;
  return [-2, -1, 1, 2].map((d) => Math.round(Math.min(hi, Math.max(lo, cur + d * step)) * 4) / 4).filter((v) => v !== cur);
}

if (require.main === module) {
  const passes = Number(process.argv[2] || 2);
  const games = Number(process.argv[3] || 9000);
  let best = JSON.parse(fs.readFileSync(PARAMS_FILE, 'utf8'));
  let seed = 1000;
  // Coordinate search: change one setting at a time and keep what wins more.
  // Both sides play the same shuffled decks, and each test is compared with the
  // current bot playing itself on those decks, so luck mostly cancels out.
  for (let pass = 0; pass < passes; pass++) {
    const tries = [...Object.keys(RANGES).flatMap((k) => candidates(k, best[k]).map((v) => ({ [k]: v }))),
      ...FLAGS.map((f) => ({ [f]: !best[f] }))];
    for (const change of tries) {
      const key = Object.keys(change)[0];
      if (key in RANGES && !candidates(key, best[key]).includes(change[key]) && best[key] !== change[key]) continue;
      const cand = { ...best, ...change };
      seed += games;
      const base = match(brainOf(best), brainOf(best), games, seed);
      const share = match(brainOf(cand), brainOf(best), games, seed);
      if (share - base > 0.008) {
        const again = match(brainOf(cand), brainOf(best), games, seed + 7777777) - match(brainOf(best), brainOf(best), games, seed + 7777777);
        if (again > 0.004) {
          best = cand;
          console.log(`pass ${pass}: ${JSON.stringify(change)} kept (+${((share - base) * 100).toFixed(1)} / +${(again * 100).toFixed(1)} points)`);
        }
      }
    }
  }
  fs.writeFileSync(PARAMS_FILE, `${JSON.stringify(best, null, 2)}\n`);
  console.log('saved', JSON.stringify(best));
}

module.exports = { playGame, match, brainOf };
