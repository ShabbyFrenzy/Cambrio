'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Game, cardValue, cardPower } = require('../server/game');

const C = (rank, suit = 'S', id) => ({ id: id ?? `${rank}${suit}${Math.random()}`, rank, suit });

// Build a deck whose deal is predictable. Deal pops from the end, round-robin.
// hands: array per player of 4 cards (slot order). extra: cards to draw after, in order.
function rigged(hands, extra = []) {
  const deal = [];
  for (let i = 0; i < 4; i++) for (const h of hands) deal.push(h[i]);
  return [...extra].reverse().concat(deal.reverse());
}

// Skip the end-of-round sticking window.
function endWindow(g) {
  g.closingUntil = 0;
  g.tryFinish();
}

function twoPlayer(extra, hands) {
  hands = hands || [
    [C('A'), C('2'), C('3'), C('4')],
    [C('5'), C('6'), C('7'), C('8')],
  ];
  const g = new Game([{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bob' }], { deck: rigged(hands, extra) });
  g.act('a', { type: 'ready' });
  g.act('b', { type: 'ready' });
  return g;
}

test('card values follow house rules', () => {
  assert.strictEqual(cardValue(C('K', 'H')), -1);
  assert.strictEqual(cardValue(C('K', 'S')), 13);
  assert.strictEqual(cardValue({ rank: 'JOKER', suit: null }), 0);
  assert.strictEqual(cardValue(C('A')), 1);
  assert.strictEqual(cardValue(C('Q')), 12);
  assert.strictEqual(cardPower(C('7')), 'peekOwn');
  assert.strictEqual(cardPower(C('10')), 'peekOther');
  assert.strictEqual(cardPower(C('J')), 'swap');
  assert.strictEqual(cardPower(C('K', 'C')), 'lookSwap');
  assert.strictEqual(cardPower(C('K', 'D')), null);
});

test('deal, initial peek shows only own bottom two', () => {
  const g = new Game([{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bob' }]);
  const v = g.view('a');
  assert.strictEqual(v.phase, 'peek');
  const mine = v.players.find((p) => p.id === 'a').slots;
  assert.ok(mine[0].hidden && mine[1].hidden && mine[2].rank && mine[3].rank);
  assert.ok(v.players.find((p) => p.id === 'b').slots.every((s) => s.hidden));
  assert.strictEqual(g.deck.length, 54 - 8);
});

test('draw and swap puts old card on discard, next player', () => {
  const g = twoPlayer([C('9', 'H')]);
  g.act('a', { type: 'draw_deck' });
  assert.strictEqual(g.view('a').drawn.rank, '9');
  assert.ok(g.view('b').drawn.hidden);
  g.act('a', { type: 'swap', slot: 0 });
  assert.strictEqual(g.players[0].hand[0].rank, '9');
  assert.strictEqual(g.discard.at(-1).rank, 'A');
  assert.strictEqual(g.current().id, 'b');
});

test('cannot draw from the discard pile', () => {
  const g = twoPlayer([C('9', 'H')]);
  g.act('a', { type: 'draw_deck' });
  g.act('a', { type: 'swap', slot: 0 });
  assert.throws(() => g.act('b', { type: 'draw_discard' }), /Unknown action/);
});

test('7 power reveals own card privately', () => {
  const g = twoPlayer([C('7', 'H')]);
  g.act('a', { type: 'draw_deck' });
  g.act('a', { type: 'discard' });
  assert.strictEqual(g.stage, 'power');
  assert.throws(() => g.act('a', { type: 'power_pick', targets: [{ pid: 'b', slot: 0 }] }), /own/);
  const { reveals } = g.act('a', { type: 'power_pick', targets: [{ pid: 'a', slot: 1 }] });
  assert.deepStrictEqual(reveals[0].to, 'a');
  assert.strictEqual(reveals[0].cards[0].card.rank, '2');
  assert.strictEqual(g.current().id, 'b');
});

test('J swaps two cards blind', () => {
  const g = twoPlayer([C('J', 'H')]);
  g.act('a', { type: 'draw_deck' });
  g.act('a', { type: 'discard' });
  g.act('a', { type: 'power_pick', targets: [{ pid: 'a', slot: 0 }, { pid: 'b', slot: 0 }] });
  assert.strictEqual(g.players[0].hand[0].rank, '5');
  assert.strictEqual(g.players[1].hand[0].rank, 'A');
});

test('black king looks at two then may swap', () => {
  const g = twoPlayer([C('K', 'S')]);
  g.act('a', { type: 'draw_deck' });
  g.act('a', { type: 'discard' });
  const { reveals } = g.act('a', { type: 'power_pick', targets: [{ pid: 'b', slot: 2 }, { pid: 'b', slot: 3 }] });
  assert.deepStrictEqual(reveals[0].cards.map((c) => c.card.rank), ['7', '8']);
  assert.strictEqual(g.view('a').power.step, 'swap');
  assert.strictEqual(g.view('b').power.revealed, null);
  g.act('a', { type: 'power_pick', targets: [{ pid: 'b', slot: 3 }, { pid: 'a', slot: 3 }] });
  assert.strictEqual(g.players[0].hand[3].rank, '8');
});

test('powers do not trigger on a swapped-out card', () => {
  const hands = [[C('7'), C('2'), C('3'), C('4')], [C('5'), C('6'), C('7'), C('8')]];
  const g = twoPlayer([C('3', 'H')], hands);
  g.act('a', { type: 'draw_deck' });
  g.act('a', { type: 'swap', slot: 0 });
  assert.strictEqual(g.stage, 'draw');
  assert.strictEqual(g.current().id, 'b');
});

test('stick own card: right card leaves hand, several sticks allowed', () => {
  const hands = [[C('A'), C('2'), C('3'), C('3', 'C')], [C('5'), C('6'), C('7'), C('3', 'D')]];
  const g = twoPlayer([C('9', 'H')], hands);
  g.act('a', { type: 'draw_deck' }); // draws 9H
  g.act('a', { type: 'swap', slot: 2 }); // discards 3S
  g.act('b', { type: 'stick', slot: 3 }); // 3D matches
  assert.strictEqual(g.players[1].hand[3], null);
  g.act('a', { type: 'stick', slot: 3 }); // 3C also matches: no limit
  assert.strictEqual(g.players[0].hand[3], null);
  assert.strictEqual(g.discard.length, 3);
});

test('wrong stick: card goes back, penalty card, can try again', () => {
  const g = twoPlayer([C('9', 'H'), C('Q', 'H'), C('K', 'H')]);
  g.act('a', { type: 'draw_deck' });
  g.act('a', { type: 'swap', slot: 2 }); // discards 3S
  g.act('a', { type: 'stick', slot: 0 }); // A on 3: wrong
  assert.strictEqual(g.players[0].hand[0].rank, 'A');
  assert.strictEqual(g.players[0].hand.length, 5);
  g.act('a', { type: 'stick', target: { pid: 'b', slot: 0 } }); // 5 on 3: wrong again
  assert.strictEqual(g.players[1].hand[0].rank, '5');
  assert.strictEqual(g.players[0].hand.length, 6);
});

test("stick another player's card, then give them one of yours", () => {
  const hands = [[C('A'), C('2'), C('3'), C('4')], [C('5'), C('6'), C('7'), C('3', 'D')]];
  const g = twoPlayer([C('9', 'H')], hands);
  g.act('a', { type: 'draw_deck' });
  g.act('a', { type: 'swap', slot: 2 }); // discards 3S
  g.act('a', { type: 'stick', target: { pid: 'b', slot: 3 } });
  assert.strictEqual(g.players[1].hand[3], null);
  assert.deepStrictEqual(g.view('a').pendingGive, { to: 'b', slot: 3 });
  assert.throws(() => g.act('a', { type: 'stick', slot: 0 }), /Wait for Ann to give a card/);
  g.act('a', { type: 'give', slot: 0 });
  assert.strictEqual(g.players[0].hand[0], null);
  assert.strictEqual(g.players[1].hand[3].rank, 'A');
  assert.strictEqual(g.view('a').pendingGive, null);
});

test("can stick the Cambrio caller's cards", () => {
  const hands = [[C('A'), C('2'), C('3'), C('4')], [C('5'), C('6'), C('7'), C('A', 'D')]];
  const g = twoPlayer([C('9', 'H'), C('3', 'H')], hands);
  g.act('a', { type: 'draw_deck' });
  g.act('a', { type: 'swap', slot: 0 }); // discards A
  g.act('b', { type: 'call_cambio' });
  g.act('a', { type: 'stick', target: { pid: 'b', slot: 3 } }); // AD on A: right
  assert.strictEqual(g.players[1].hand[3], null);
  g.act('a', { type: 'give', slot: 1 });
  assert.strictEqual(g.players[1].hand[3].rank, '2');
});

test('cambio: everyone else gets one turn, caller cards can be swapped, lowest wins', () => {
  const g = new Game(
    [{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bob' }, { id: 'c', name: 'Cy' }],
    { deck: rigged([
      [C('A'), C('A', 'H'), C('2'), C('K', 'H')], // 3
      [C('5'), C('6'), C('7'), C('8')], // 26
      [C('9'), C('10'), C('J'), C('Q')], // 42
    ], [C('J', 'D'), C('4', 'D')]) },
  );
  for (const id of ['a', 'b', 'c']) g.act(id, { type: 'ready' });
  g.act('a', { type: 'call_cambio' });
  assert.strictEqual(g.current().id, 'b');
  g.act('b', { type: 'draw_deck' }); // JD
  g.act('b', { type: 'discard' });
  g.act('b', { type: 'power_pick', targets: [{ pid: 'a', slot: 0 }, { pid: 'b', slot: 0 }] });
  assert.strictEqual(g.players[0].hand[0].rank, '5'); // swapped with the caller
  assert.strictEqual(g.players[1].hand[0].rank, 'A');
  assert.strictEqual(g.phase, 'play');
  g.act('c', { type: 'draw_deck' });
  g.act('c', { type: 'swap', slot: 3 }); // Q -> 4: 34
  assert.strictEqual(g.stage, 'closing');
  endWindow(g);
  assert.strictEqual(g.phase, 'ended');
  assert.deepStrictEqual(g.results.winners, ['a']);
  assert.deepStrictEqual(g.results.scores.map((s) => s.score), [7, 22, 34]);
  assert.ok(g.view('b').players[0].slots[0].rank); // everything revealed
});

test('caller wins ties', () => {
  const g = twoPlayer([C('5', 'C')], [[C('A'), C('2'), C('3'), C('4')], [C('4', 'H'), C('3', 'H'), C('2', 'H'), C('A', 'H')]]);
  g.act('a', { type: 'call_cambio' });
  g.act('b', { type: 'draw_deck' });
  g.act('b', { type: 'discard' });
  assert.strictEqual(g.stage, 'closing');
  endWindow(g);
  assert.strictEqual(g.phase, 'ended');
  assert.deepStrictEqual(g.results.winners, ['a']);
  assert.strictEqual(g.results.tieBreak, 'cambio');
});

test('other ties go to the lowest single card', () => {
  const g = new Game(
    [{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bob' }, { id: 'c', name: 'Cy' }],
    { deck: rigged([
      [C('9'), C('9', 'H'), C('9', 'D'), C('9', 'C')], // 36, caller
      [C('2'), C('3'), C('3', 'H'), C('2', 'H')], // 10, lowest card 2
      [C('A'), C('4'), C('4', 'H'), C('A', 'H')], // 10, lowest card 1
    ], [C('5', 'C'), C('5', 'D')]) },
  );
  for (const id of ['a', 'b', 'c']) g.act(id, { type: 'ready' });
  g.act('a', { type: 'call_cambio' });
  g.act('b', { type: 'draw_deck' }); g.act('b', { type: 'discard' });
  g.act('c', { type: 'draw_deck' }); g.act('c', { type: 'discard' });
  endWindow(g);
  assert.deepStrictEqual(g.results.winners, ['c']);
  assert.strictEqual(g.results.tieBreak, 'lowestCard');
});

test('disconnected players are skipped and do not block the peek phase', () => {
  const g = new Game([{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bob' }, { id: 'c', name: 'Cy' }]);
  g.act('a', { type: 'ready' });
  g.setConnected('b', false);
  g.act('c', { type: 'ready' });
  assert.strictEqual(g.phase, 'play');
  g.act('a', { type: 'draw_deck' });
  g.act('a', { type: 'swap', slot: 0 });
  assert.strictEqual(g.current().id, 'c');
});

test('player leaving mid-game keeps the game going', () => {
  const g = new Game([{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bob' }, { id: 'c', name: 'Cy' }]);
  for (const id of ['a', 'b', 'c']) g.act(id, { type: 'ready' });
  g.act('a', { type: 'draw_deck' });
  g.removePlayer('a');
  assert.strictEqual(g.phase, 'play');
  assert.strictEqual(g.current().id, 'b');
  assert.strictEqual(g.stage, 'draw');
  g.removePlayer('c');
  assert.strictEqual(g.phase, 'ended');
});

test('animation events never leak hidden cards', () => {
  const hands = [[C('A'), C('2'), C('3'), C('4')], [C('5'), C('6'), C('7'), C('3', 'D')]];
  const g = twoPlayer([C('9', 'H')], hands);
  g.act('a', { type: 'draw_deck' });
  assert.deepStrictEqual(g.view('b').fx.events, [{ kind: 'move', from: { zone: 'deck' }, to: { zone: 'drawn' }, card: null }]);
  g.act('a', { type: 'swap', slot: 2 });
  const ev = g.view('b').fx.events;
  assert.strictEqual(ev[0].card, null); // drawn card going into the hand stays hidden
  assert.strictEqual(ev[1].card.rank, '3'); // discarded card is public
  g.act('a', { type: 'stick', target: { pid: 'b', slot: 3 } });
  const st = g.view('b').fx.events[0];
  assert.strictEqual(st.kind, 'stick');
  assert.strictEqual(st.ok, true);
  g.act('a', { type: 'give', slot: 0 });
  assert.deepStrictEqual(g.view('b').fx.events, [{ kind: 'move', from: { pid: 'a', slot: 0 }, to: { pid: 'b', slot: 3 }, card: null }]);
});

test('6-card hands deal 6 and peek the bottom three', () => {
  const g = new Game([{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bob' }], { handSize: 6 });
  assert.strictEqual(g.players[0].hand.length, 6);
  assert.strictEqual(g.deck.length, 54 - 12);
  const mine = g.view('a').players[0].slots;
  assert.deepStrictEqual(mine.map((c) => !c.hidden), [false, false, false, true, true, true]);
  assert.strictEqual(g.view('a').peekCount, 3);
  const seven = Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
  assert.throws(() => new Game(seven, { handSize: 6 }), /At most 6/);
  assert.throws(() => new Game(seven.slice(0, 2), { handSize: 5 }), /4 or 6/);
});

test('rooms: host sets max players, joins stop at the limit', () => {
  const rooms = require('../server/rooms');
  const room = rooms.createRoom();
  rooms.joinRoom(room.code, { playerId: 'h', name: 'Host' });
  rooms.joinRoom(room.code, { playerId: 'p2', name: 'Two' });
  assert.throws(() => rooms.setMaxPlayers(room.code, 'p2', 3), /Only the host/);
  assert.throws(() => rooms.setMaxPlayers(room.code, 'h', 9), /2 to 8/);
  rooms.setMaxPlayers(room.code, 'h', 3);
  rooms.joinRoom(room.code, { playerId: 'p3', name: 'Three' });
  assert.throws(() => rooms.joinRoom(room.code, { playerId: 'p4', name: 'Four' }), /full/);
  assert.throws(() => rooms.setMaxPlayers(room.code, 'h', 2), /already 3/);
  rooms.setMaxPlayers(room.code, 'h', 8);
  rooms.setHandSize(room.code, 'h', 6);
  assert.strictEqual(rooms.getRoom(room.code).maxPlayers, 6);
  assert.throws(() => rooms.setMaxPlayers(room.code, 'h', 7), /2 to 6/);
});

test('with a 5s turn timer, the final sticking window is 5s too', () => {
  let now = 1000;
  const hands = [[C('A'), C('2'), C('3'), C('4')], [C('5'), C('6'), C('7'), C('8')]];
  const deck = rigged(hands, [C('9', 'H'), C('8', 'H')]);
  const g = new Game([{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bob' }], { deck, now: () => now, turnMs: 5000 });
  g.act('a', { type: 'ready' }); g.act('b', { type: 'ready' });
  g.act('a', { type: 'call_cambio' });
  g.act('b', { type: 'draw_deck' });
  g.act('b', { type: 'swap', slot: 0 }); // discards 5
  assert.strictEqual(g.phase, 'play');
  assert.strictEqual(g.stage, 'closing');
  assert.strictEqual(g.view('a').closingMsLeft, 5000);
  assert.strictEqual(g.view('a').current, null);
  assert.throws(() => g.act('a', { type: 'draw_deck' }));
  g.act('a', { type: 'stick', slot: 0 }); // A on 5: wrong, still allowed
  assert.strictEqual(g.players[0].hand.length, 5);
  now += 4000;
  assert.strictEqual(g.tryFinish(), false);
  now += 1000;
  assert.strictEqual(g.tryFinish(), true);
  assert.strictEqual(g.phase, 'ended');
});

test('everything pauses until a sticker gives their card, even past the deadline', () => {
  let now = 0;
  const hands = [[C('A'), C('2'), C('3'), C('4')], [C('5'), C('6'), C('7'), C('5', 'D')]];
  const deck = rigged(hands, [C('4', 'H')]);
  const g = new Game([{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bob' }], { deck, now: () => now, turnMs: 5000 });
  g.act('a', { type: 'ready' }); g.act('b', { type: 'ready' });
  g.act('a', { type: 'call_cambio' });
  g.act('b', { type: 'draw_deck' });
  g.act('b', { type: 'swap', slot: 0 }); // discards 5S, final turn over
  assert.strictEqual(g.stage, 'closing');
  g.act('a', { type: 'stick', target: { pid: 'b', slot: 3 } }); // 5D: right
  assert.throws(() => g.act('b', { type: 'stick', slot: 1 }), /Wait for Ann to give a card/);
  now = 10000;
  assert.strictEqual(g.tryFinish(), false);
  assert.strictEqual(g.view('b').closingMsLeft, 5000); // the clock stood still while paused
  g.act('a', { type: 'give', slot: 0 });
  assert.strictEqual(g.phase, 'play');
  now = 15000;
  assert.strictEqual(g.tryFinish(), true);
  assert.strictEqual(g.phase, 'ended');
});

test('no turn timer: the round ends when everyone presses No more sticks', () => {
  const g = twoPlayer([C('9', 'H')]);
  g.act('a', { type: 'call_cambio' });
  g.act('b', { type: 'draw_deck' });
  g.act('b', { type: 'swap', slot: 0 });
  assert.strictEqual(g.stage, 'closing');
  assert.strictEqual(g.view('a').closingMsLeft, null);
  g.act('a', { type: 'done_sticking' });
  assert.strictEqual(g.phase, 'play');
  assert.deepStrictEqual(g.view('b').doneSticking, ['a']);
  g.act('b', { type: 'done_sticking' });
  assert.strictEqual(g.phase, 'ended');
});

test('turn timer: running out skips the turn and discards a held card', () => {
  let now = 0;
  const hands = [[C('A'), C('2'), C('3'), C('4')], [C('5'), C('6'), C('7'), C('8')]];
  const deck = rigged(hands, [C('9', 'H'), C('6', 'H')]);
  const g = new Game([{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bob' }], { deck, now: () => now, turnMs: 10000 });
  g.act('a', { type: 'ready' }); g.act('b', { type: 'ready' });
  assert.strictEqual(g.view('a').turnMsLeft, 10000);
  now = 4000;
  g.act('a', { type: 'draw_deck' }); // 9H, and drawing restarts the timer
  assert.strictEqual(g.view('a').turnMsLeft, 10000);
  now = 13999;
  assert.strictEqual(g.checkTurnTimeout(), false);
  now = 14000;
  assert.strictEqual(g.checkTurnTimeout(), true);
  assert.strictEqual(g.discard.at(-1).rank, '9');
  assert.strictEqual(g.stage, 'draw');
  assert.strictEqual(g.current().id, 'b');
  assert.strictEqual(g.view('b').turnMsLeft, 10000);
  now = 24000;
  assert.strictEqual(g.checkTurnTimeout(), true); // b did nothing
  assert.strictEqual(g.current().id, 'a');
});

test('autoGive hands over a random card when the sticker stalls', () => {
  const hands = [[C('A'), C('2'), C('3'), C('4')], [C('5'), C('6'), C('7'), C('3', 'D')]];
  const g = twoPlayer([C('9', 'H')], hands);
  g.act('a', { type: 'draw_deck' });
  g.act('a', { type: 'swap', slot: 2 }); // discards 3S
  g.act('a', { type: 'stick', target: { pid: 'b', slot: 3 } });
  assert.ok(g.autoGive('a'));
  assert.ok(g.players[1].hand[3]);
  assert.strictEqual(g.view('a').pendingGive, null);
});

function modeGame(mode, extra, hands) {
  hands = hands || [[C('A'), C('2'), C('3'), C('4')], [C('5'), C('6'), C('7'), C('8')]];
  const g = new Game([{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bob' }], { deck: rigged(hands, extra), mode });
  g.act('a', { type: 'ready' }); g.act('b', { type: 'ready' });
  return g;
}

test('easy mode: cards you have seen stay face up for you, even after they move', () => {
  const g = modeGame('easy', [C('9', 'H'), C('2', 'H')]);
  const shown = (pid, owner) => g.view(pid).players.find((p) => p.id === owner).slots.map((c) => (c.hidden ? '?' : c.rank));
  assert.deepStrictEqual(shown('a', 'a'), ['?', '?', '3', '4']); // bottom row seen at the start
  assert.deepStrictEqual(shown('b', 'a'), ['?', '?', '?', '?']);
  g.act('a', { type: 'draw_deck' }); // 9H
  g.act('a', { type: 'discard' });
  g.act('a', { type: 'power_pick', targets: [{ pid: 'b', slot: 0 }] }); // looks at Bob's 5
  assert.deepStrictEqual(shown('a', 'b'), ['5', '?', '?', '?']);
  g.act('b', { type: 'draw_deck' }); // 2H
  g.act('b', { type: 'swap', slot: 0 }); // Bob swaps his 5 out for the 2H he drew
  assert.deepStrictEqual(shown('b', 'b'), ['2', '?', '7', '8']);
  assert.deepStrictEqual(shown('a', 'b'), ['?', '?', '?', '?']);
});

test('normal mode hides seen cards and hard mode keeps notes on cards', () => {
  const n = modeGame('normal', [C('9', 'H')]);
  assert.ok(n.view('a').players[0].slots.every((c) => c.hidden));
  assert.throws(() => n.act('a', { type: 'note', target: { pid: 'b', slot: 0 }, note: { is: ['5'] } }), /hard mode/);
  assert.strictEqual(n.view('a').unplayed, null);

  const g = modeGame('hard', [C('9', 'H'), C('J', 'H')]);
  assert.ok(g.view('a').players[0].slots.every((c) => c.hidden));
  g.act('a', { type: 'note', target: { pid: 'b', slot: 1 }, note: { is: ['6', 'X'], not: ['K', '6'] } });
  assert.deepStrictEqual(g.view('a').players[1].slots[1].note, { is: ['6'], not: ['K'] });
  assert.strictEqual(g.view('b').players[1].slots[1].note, undefined); // private
  // The note follows the card when a J/Q swap moves it.
  g.act('a', { type: 'draw_deck' }); g.act('a', { type: 'discard' }); // 9H: peek other
  g.act('a', { type: 'power_pick', targets: [{ pid: 'b', slot: 0 }] });
  g.act('b', { type: 'draw_deck' }); g.act('b', { type: 'discard' }); // JH: swap
  g.act('b', { type: 'power_pick', targets: [{ pid: 'b', slot: 1 }, { pid: 'a', slot: 0 }] });
  assert.deepStrictEqual(g.view('a').players[0].slots[0].note, { is: ['6'], not: ['K'] });
  // Notes work while the table is paused, and clearing removes them.
  g.act('a', { type: 'note', target: { pid: 'a', slot: 0 }, note: {} });
  assert.strictEqual(g.view('a').players[0].slots[0].note, undefined);
  const left = g.view('a').unplayed;
  assert.strictEqual(left['9'], undefined); // the only 9 was discarded
  assert.strictEqual(left.A, 1);
});

test('rooms: mode is host-only, private only, and passed to the game', () => {
  const rooms = require('../server/rooms');
  const room = rooms.createRoom();
  rooms.joinRoom(room.code, { playerId: 'h', name: 'Host' });
  rooms.joinRoom(room.code, { playerId: 'g', name: 'Guest' });
  assert.throws(() => rooms.setMode(room.code, 'g', 'easy'), /host/);
  assert.throws(() => rooms.setMode(room.code, 'h', 'silly'));
  rooms.setMode(room.code, 'h', 'hard');
  assert.strictEqual(rooms.view(room).mode, 'hard');
  assert.strictEqual(rooms.startGame(room.code).mode, 'hard');
});
