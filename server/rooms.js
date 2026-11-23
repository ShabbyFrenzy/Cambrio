'use strict';
// Room registry. A room is a lobby of players that can play rounds of Cambrio.
// Players are identified by a stable playerId the browser keeps in localStorage.

const { Game, MAX_PLAYERS, MIN_PLAYERS, HAND_SIZES, MAX_PLAYERS_BY_HAND } = require('./game');

const rooms = new Map();
// No I or O, to avoid confusion with 1 and 0.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 5;

class RoomError extends Error {}

function newCode() {
  for (let tries = 0; tries < 1000; tries++) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  throw new RoomError('Could not make a room code');
}

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

function cleanName(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 20);
  return n || 'Player';
}

function createRoom() {
  const code = newCode();
  const room = {
    code,
    hostId: null,
    players: [], // {playerId, name, connected, totalScore, wins}
    game: null,
    handSize: 4,
    maxPlayers: MAX_PLAYERS, // host can lower this for private rooms
    round: 0,
    createdAt: Date.now(),
    lastActive: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function getRoom(code) {
  return rooms.get(normalizeCode(code)) || null;
}

/** Adds a player, or reconnects one already seated. Returns the room player. */
function joinRoom(code, { playerId, name }) {
  const room = getRoom(code);
  if (!room) throw new RoomError('That room does not exist. Check the code?');
  if (!playerId) throw new RoomError('Missing player id');
  room.lastActive = Date.now();
  let p = room.players.find((x) => x.playerId === playerId);
  if (p) {
    if (name) p.name = cleanName(name);
    return p;
  }
  if (room.game && room.game.phase !== 'ended') {
    throw new RoomError('A game is already in progress in this room. Wait for it to finish.');
  }
  if (room.players.length >= room.maxPlayers) throw new RoomError('This room is full');
  p = { playerId, name: cleanName(name), connected: true, totalScore: 0, wins: 0 };
  room.players.push(p);
  if (!room.hostId) room.hostId = playerId;
  return p;
}

function leaveRoom(code, playerId) {
  const room = getRoom(code);
  if (!room) return;
  room.players = room.players.filter((p) => p.playerId !== playerId);
  if (room.game) room.game.removePlayer(playerId);
  if (room.hostId === playerId) room.hostId = room.players[0] ? room.players[0].playerId : null;
  if (room.players.length === 0) rooms.delete(room.code);
}

function startGame(code, byPlayerId) {
  const room = getRoom(code);
  if (!room) throw new RoomError('Room not found');
  if (byPlayerId && room.hostId !== byPlayerId) throw new RoomError('Only the host can start the game');
  if (room.game && room.game.phase !== 'ended') throw new RoomError('A game is already running');
  const seated = room.players.filter((p) => p.connected);
  if (seated.length < MIN_PLAYERS) throw new RoomError(`Need at least ${MIN_PLAYERS} players to start`);
  // Rotate who goes first each round.
  const offset = room.round % seated.length;
  const order = seated.slice(offset).concat(seated.slice(0, offset));
  const max = MAX_PLAYERS_BY_HAND[room.handSize];
  if (order.length > max) throw new RoomError(`With ${room.handSize} cards each, at most ${max} players can play. Switch to 4 cards.`);
  room.game = new Game(order.map((p) => ({ id: p.playerId, name: p.name })), { handSize: room.handSize });
  room.round++;
  room.scored = false;
  room.lastActive = Date.now();
  return room.game;
}

function setHandSize(code, byPlayerId, size) {
  const room = getRoom(code);
  if (!room) throw new RoomError('Room not found');
  if (room.hostId !== byPlayerId) throw new RoomError('Only the host can change this');
  if (room.game && room.game.phase !== 'ended') throw new RoomError('Wait for this game to finish');
  const n = Number(size);
  if (!HAND_SIZES.includes(n)) throw new RoomError('Hands can be 4 or 6 cards');
  const cap = MAX_PLAYERS_BY_HAND[n];
  if (room.players.length > cap) {
    throw new RoomError(`With ${n} cards each, at most ${cap} players can play. There are ${room.players.length} here.`);
  }
  room.handSize = n;
  room.maxPlayers = Math.min(room.maxPlayers, cap);
}

function setMaxPlayers(code, byPlayerId, value) {
  const room = getRoom(code);
  if (!room) throw new RoomError('Room not found');
  if (room.hostId !== byPlayerId) throw new RoomError('Only the host can change this');
  const n = Number(value);
  const cap = MAX_PLAYERS_BY_HAND[room.handSize];
  if (!Number.isInteger(n) || n < MIN_PLAYERS || n > cap) {
    throw new RoomError(`Max players must be ${MIN_PLAYERS} to ${cap}`);
  }
  if (n < room.players.length) throw new RoomError(`There are already ${room.players.length} players in the room`);
  room.maxPlayers = n;
}

/** After a game ends, add its scores to the room's running totals (once). */
function recordResults(room) {
  const g = room.game;
  if (!g || g.phase !== 'ended' || room.scored) return;
  room.scored = true;
  for (const s of g.results.scores) {
    const p = room.players.find((x) => x.playerId === s.id);
    if (p) p.totalScore += s.score;
  }
  for (const id of g.results.winners) {
    const p = room.players.find((x) => x.playerId === id);
    if (p) p.wins++;
  }
}

/** For matchmaking: make a room already holding these players. Returns the code. */
function createRoomWithPlayers(players, { autoStart = false } = {}) {
  const room = createRoom();
  for (const p of players) joinRoom(room.code, { playerId: p.playerId, name: p.name });
  room.isPublic = true;
  if (autoStart) {
    // Players have not opened the room yet. Mark them away and make the peek
    // phase wait until they arrive (server/index.js gives up after a timeout).
    const game = startGame(room.code);
    for (const p of room.players) p.connected = false;
    for (const gp of game.players) {
      gp.connected = false;
      game.awaiting.add(gp.id);
    }
  }
  return room.code;
}

function view(room, playerId) {
  return {
    code: room.code,
    hostId: room.hostId,
    you: playerId,
    round: room.round,
    handSize: room.handSize,
    maxPlayers: room.maxPlayers,
    maxPlayersCap: MAX_PLAYERS_BY_HAND[room.handSize],
    isPublic: !!room.isPublic,
    players: room.players.map((p) => ({
      id: p.playerId,
      name: p.name,
      connected: p.connected,
      totalScore: p.totalScore,
      wins: p.wins,
    })),
    game: room.game ? room.game.view(playerId) : null,
  };
}

function sweep(maxIdleMs = 30 * 60 * 1000) {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyone = room.players.some((p) => p.connected);
    if (!anyone && now - room.lastActive > maxIdleMs) rooms.delete(code);
  }
}

module.exports = {
  rooms, RoomError, createRoom, getRoom, joinRoom, leaveRoom, startGame, setHandSize, setMaxPlayers,
  createRoomWithPlayers, recordResults, view, sweep, normalizeCode, cleanName,
};
