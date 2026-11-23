'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const rooms = require('./rooms');
const { GameError, GIVE_TIMEOUT_MS } = require('./game');

const PORT = process.env.PORT || 3000;
const TURN_TIMEOUT_MS = 45 * 1000; // skip an away player's turn after this long
const MATCH_JOIN_TIMEOUT_MS = 30 * 1000; // matchmade rooms stop waiting after this long

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/healthz', (_req, res) => res.send('ok'));
// Friendly room links: /r/ABCDE -> /?room=ABCDE
app.get('/r/:code', (req, res) => res.redirect(`/?room=${encodeURIComponent(req.params.code)}`));

// ---------- helpers ----------
function broadcast(room) {
  if (room.game && room.game.phase === 'ended') rooms.recordResults(room);
  const ids = io.sockets.adapter.rooms.get(room.code);
  if (!ids) return;
  for (const sid of ids) {
    const s = io.sockets.sockets.get(sid);
    if (s && s.data.playerId) s.emit('state', rooms.view(room, s.data.playerId));
  }
}

function sendReveals(room, reveals) {
  for (const r of reveals) {
    const ids = io.sockets.adapter.rooms.get(room.code) || [];
    for (const sid of ids) {
      const s = io.sockets.sockets.get(sid);
      if (s && s.data.playerId === r.to) s.emit('reveal', { cards: r.cards });
    }
  }
}

function socketsFor(room, playerId) {
  const ids = io.sockets.adapter.rooms.get(room.code) || [];
  return [...ids].map((sid) => io.sockets.sockets.get(sid)).filter((s) => s && s.data.playerId === playerId);
}

// Skip the turn of a player who stays away too long.
const turnTimers = new Map(); // code -> timeout
const clockTimers = new Map(); // code -> timeout for the turn timer
const closeTimers = new Map(); // code -> timeout for the end-of-round sticking window
const giveTimers = new Map(); // "code:playerId" -> timeout for a sticker who must give a card

function checkTimers(room) {
  const g = room.game;
  // End the sticking window on time (or as soon as any pending give is done).
  clearTimeout(closeTimers.get(room.code));
  closeTimers.delete(room.code);
  // Turn timer: skip the turn when it runs out.
  clearTimeout(clockTimers.get(room.code));
  clockTimers.delete(room.code);
  if (g && g.phase === 'play' && g.stage !== 'closing' && g.turnDeadline && g.pauseStart === null) {
    const wait = Math.max(0, g.turnDeadline - Date.now()) + 50;
    clockTimers.set(room.code, setTimeout(() => {
      clockTimers.delete(room.code);
      if (room.game === g && g.checkTurnTimeout()) { broadcast(room); checkAwayTurn(room); }
    }, wait).unref());
  }
  if (g && g.phase === 'play' && g.stage === 'closing' && g.closingUntil !== null && g.pauseStart === null) {
    const wait = Math.max(0, g.closingUntil - Date.now()) + 50;
    closeTimers.set(room.code, setTimeout(() => {
      closeTimers.delete(room.code);
      if (room.game === g && g.tryFinish()) broadcast(room);
    }, wait).unref());
  }
  // A sticker who never gives a card would freeze the table: give a random one.
  for (const pid of Object.keys((g && g.pendingGive) || {})) {
    const k = `${room.code}:${pid}`;
    if (giveTimers.has(k)) continue;
    giveTimers.set(k, setTimeout(() => {
      giveTimers.delete(k);
      if (room.game === g && g.autoGive(pid)) {
        g.tryFinish();
        broadcast(room);
        checkAwayTurn(room);
      }
    }, GIVE_TIMEOUT_MS).unref());
  }
}

function checkAwayTurn(room) {
  checkTimers(room);
  clearTimeout(turnTimers.get(room.code));
  turnTimers.delete(room.code);
  const g = room.game;
  if (!g || g.phase !== 'play' || g.stage === 'closing' || g.turnMs) return; // the turn timer handles away players
  const cur = g.current();
  if (cur.connected) return;
  turnTimers.set(room.code, setTimeout(() => {
    turnTimers.delete(room.code);
    if (room.game === g && g.phase === 'play' && g.current().id === cur.id && !cur.connected) {
      g.forfeitTurn(cur.id);
      broadcast(room);
      checkAwayTurn(room);
    }
  }, TURN_TIMEOUT_MS).unref());
}

function attachToRoom(socket, room, player) {
  if (socket.data.code && socket.data.code !== room.code) socket.leave(socket.data.code);
  socket.data.code = room.code;
  socket.data.playerId = player.playerId;
  socket.join(room.code);
  player.connected = true;
  if (room.game) room.game.setConnected(player.playerId, true);
}

function safe(socket, fn) {
  return (data = {}, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    try {
      reply({ ok: true, ...(fn(data) || {}) });
    } catch (err) {
      if (err instanceof GameError || err instanceof rooms.RoomError) {
        reply({ ok: false, error: err.message });
      } else {
        console.error(err);
        reply({ ok: false, error: 'Something went wrong' });
      }
    }
  };
}

function currentRoom(socket) {
  const room = socket.data.code && rooms.getRoom(socket.data.code);
  if (!room) throw new rooms.RoomError('You are not in a room');
  return room;
}

// ---------- sockets ----------
io.on('connection', (socket) => {
  socket.on('create_room', safe(socket, ({ name, playerId }) => {
    const room = rooms.createRoom();
    const player = rooms.joinRoom(room.code, { playerId: String(playerId || ''), name });
    attachToRoom(socket, room, player);
    broadcast(room);
    return { code: room.code };
  }));

  socket.on('join_room', safe(socket, ({ code, name, playerId }) => {
    const room = rooms.getRoom(code);
    const player = rooms.joinRoom(code, { playerId: String(playerId || ''), name });
    attachToRoom(socket, room, player);
    broadcast(room);
    checkAwayTurn(room);
    return { code: room.code };
  }));

  socket.on('leave_room', safe(socket, () => {
    const room = currentRoom(socket);
    const pid = socket.data.playerId;
    socket.leave(room.code);
    socket.data.code = null;
    rooms.leaveRoom(room.code, pid);
    if (rooms.getRoom(room.code)) {
      broadcast(room);
      checkAwayTurn(room);
    }
  }));

  socket.on('start_game', safe(socket, () => {
    const room = currentRoom(socket);
    rooms.startGame(room.code, socket.data.playerId);
    broadcast(room);
  }));

  socket.on('set_hand_size', safe(socket, ({ size }) => {
    const room = currentRoom(socket);
    rooms.setHandSize(room.code, socket.data.playerId, size);
    broadcast(room);
  }));

  socket.on('set_turn_timer', safe(socket, ({ value }) => {
    const room = currentRoom(socket);
    rooms.setTurnTimer(room.code, socket.data.playerId, value);
    broadcast(room);
  }));

  socket.on('set_mode', safe(socket, ({ value }) => {
    const room = currentRoom(socket);
    rooms.setMode(room.code, socket.data.playerId, value);
    broadcast(room);
  }));

  socket.on('set_max_players', safe(socket, ({ value }) => {
    const room = currentRoom(socket);
    rooms.setMaxPlayers(room.code, socket.data.playerId, value);
    broadcast(room);
  }));

  socket.on('action', safe(socket, (action) => {
    const room = currentRoom(socket);
    if (!room.game) throw new rooms.RoomError('No game is running');
    room.lastActive = Date.now();
    const { reveals } = room.game.act(socket.data.playerId, action);
    sendReveals(room, reveals);
    broadcast(room);
    checkAwayTurn(room);
  }));

  socket.on('disconnect', () => {
    const room = socket.data.code && rooms.getRoom(socket.data.code);
    if (!room) return;
    const pid = socket.data.playerId;
    // Another tab of the same player may still be open.
    if (socketsFor(room, pid).length > 0) return;
    const p = room.players.find((x) => x.playerId === pid);
    if (p) p.connected = false;
    if (room.game) room.game.setConnected(pid, false);
    room.lastActive = Date.now();
    broadcast(room);
    checkAwayTurn(room);
  });
});

// ---------- quick play (random matchmaking) ----------
try {
  const { attachQuickPlay } = require('./matchmaking');
  attachQuickPlay(io, {
    createGame: (players) => {
      const code = rooms.createRoomWithPlayers(players, { autoStart: true });
      const room = rooms.getRoom(code);
      setTimeout(() => {
        if (room.game && room.game.awaiting.size) {
          room.game.stopAwaiting();
          broadcast(room);
          checkAwayTurn(room);
        }
      }, MATCH_JOIN_TIMEOUT_MS).unref();
      return code;
    },
  });
} catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') throw err;
  console.log('Quick play module not found; private rooms only.');
}

setInterval(() => rooms.sweep(), 5 * 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`Cambrio running on http://localhost:${PORT}`));
}

module.exports = { app, server, io };
