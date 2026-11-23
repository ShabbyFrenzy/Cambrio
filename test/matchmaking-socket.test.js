// End to end: real Socket.IO server, several fake browser clients.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { Server } = require('socket.io');
const Client = require('socket.io-client');
const { attachQuickPlay } = require('../server/matchmaking');

test('5 clients: 4 get the same room, the 5th keeps waiting, then leaving works', async () => {
  const server = http.createServer();
  const io = new Server(server);
  const rooms = [];
  const mm = attachQuickPlay(io, { createGame: (p) => { rooms.push(p.length); return 'ROOM' + rooms.length; } });
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;

  const clients = await Promise.all(Array.from({ length: 5 }, () => new Promise((r) => {
    const c = Client(url, { transports: ['websocket'] });
    c.on('connect', () => r(c));
  })));

  const matched = [];
  clients.forEach((c, i) => c.on('matched', (m) => matched.push([i, m])));
  for (let i = 0; i < 5; i++) {
    clients[i].emit('quickplay:join', { name: 'P' + i, playerId: 'id' + i });
    await new Promise((r) => setTimeout(r, 30));
  }
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(matched.length, 4);
  assert.ok(matched.every(([, m]) => m.code === 'ROOM1'));
  assert.deepEqual(matched.map(([i]) => i).sort(), [0, 1, 2, 3]);
  assert.equal(mm.queue.length, 1);

  clients[4].disconnect();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(mm.queue.length, 0);

  clients.forEach((c) => c.close());
  mm.stop();
  io.close();
});
