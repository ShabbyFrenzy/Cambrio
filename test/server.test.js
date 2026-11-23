'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { io: Client } = require('socket.io-client');
const { server, io } = require('../server/index');

function connect(url) {
  return new Promise((res) => { const s = Client(url, { forceNew: true }); s.on('connect', () => res(s)); });
}
const emit = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));
const nextState = (s, pred = () => true) => new Promise((res) => {
  const h = (st) => { if (pred(st)) { s.off('state', h); res(st); } };
  s.on('state', h);
});

test('two players create, join, play a turn over sockets', async () => {
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;
  const a = await connect(url); const b = await connect(url);
  const r1 = await emit(a, 'create_room', { name: 'Ann', playerId: 'pa' });
  assert.ok(r1.ok && /^[A-Z]{5}$/.test(r1.code));
  const bad = await emit(b, 'join_room', { code: 'ZZZZZ', name: 'Bob', playerId: 'pb' });
  assert.strictEqual(bad.ok, false);
  const r2 = await emit(b, 'join_room', { code: r1.code.toLowerCase(), name: 'Bob', playerId: 'pb' });
  assert.ok(r2.ok);
  const notHost = await emit(b, 'start_game', {});
  assert.strictEqual(notHost.ok, false);
  const peekState = nextState(b, (s) => s.game && s.game.phase === 'peek');
  assert.ok((await emit(a, 'start_game', {})).ok);
  const st = await peekState;
  const bSeat = st.game.players.find((p) => p.id === 'pb');
  assert.ok(bSeat.slots[2].rank && bSeat.slots[0].hidden);
  assert.ok(st.game.players.find((p) => p.id === 'pa').slots.every((c) => c.hidden));
  await emit(a, 'action', { type: 'ready' });
  const playing = nextState(a, (s) => s.game.phase === 'play');
  await emit(b, 'action', { type: 'ready' });
  const ps = await playing;
  const first = ps.game.current === 'pa' ? a : b;
  const other = first === a ? b : a;
  const wrong = await emit(other, 'action', { type: 'draw_deck' });
  assert.strictEqual(wrong.ok, false);
  assert.ok((await emit(first, 'action', { type: 'draw_deck' })).ok);
  assert.ok((await emit(first, 'action', { type: 'swap', slot: 0 })).ok);
  // Reconnect: a fresh socket with the same playerId rejoins its seat.
  const otherId = other === a ? 'pa' : 'pb';
  other.disconnect();
  const back = await connect(url);
  const rj = await emit(back, 'join_room', { code: r1.code, name: 'X', playerId: otherId });
  assert.ok(rj.ok);
  a.disconnect(); b.disconnect(); back.disconnect();
  io.close(); server.close();
});
