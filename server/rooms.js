'use strict';
// Room registry. A room is a lobby of players that can play rounds of Cambrio.
// Players are identified by a stable playerId the browser keeps in localStorage.

const { Game, MAX_PLAYERS, MIN_PLAYERS, HAND_SIZES, MAX_PLAYERS_BY_HAND, TURN_TIMER_CHOICES, OPTIONS } = require('./game');
const QUICK_PLAY_TURN_SECONDS = 30;
const TARGET_CHOICES = [0, 50, 100]; // 0 = play rounds forever

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
    turnSeconds: 0, // 0 = no turn timer
    options: Object.fromEntries(OPTIONS.map((k) => [k, false])), // game options, private rooms only
    targetScore: 0, // play rounds until someone reaches this total (0 = no target)
    matchOver: null, // { winners: [playerId] } once someone reaches the target
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
  const humans = room.players.filter((p) => !p.bot);
  if (room.hostId === playerId) room.hostId = humans[0] ? humans[0].playerId : null;
  if (humans.length === 0) rooms.delete(room.code); // bots never keep a room alive
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
  if (room.matchOver) {
    // A new match: everyone starts again from zero.
    for (const p of room.players) { p.totalScore = 0; p.wins = 0; }
    room.matchOver = null;
  }
  room.game = new Game(order.map((p) => ({ id: p.playerId, name: p.name })), { handSize: room.handSize, turnMs: room.turnSeconds * 1000, options: room.isPublic ? {} : room.options });
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

function setTurnTimer(code, byPlayerId, value) {
  const room = getRoom(code);
  if (!room) throw new RoomError('Room not found');
  if (room.hostId !== byPlayerId) throw new RoomError('Only the host can change this');
  if (room.game && room.game.phase !== 'ended') throw new RoomError('Wait for this game to finish');
  const n = Number(value);
  if (!TURN_TIMER_CHOICES.includes(n)) throw new RoomError('Pick one of the listed turn timers');
  room.turnSeconds = n;
}

function setOption(code, byPlayerId, key, value) {
  const room = getRoom(code);
  if (!room) throw new RoomError('Room not found');
  if (room.hostId !== byPlayerId) throw new RoomError('Only the host can change this');
  if (room.isPublic) throw new RoomError('Quick play games have no extra options');
  if (room.game && room.game.phase !== 'ended') throw new RoomError('Wait for this game to finish');
  if (!OPTIONS.includes(key)) throw new RoomError('Unknown option');
  room.options = { ...room.options, [key]: !!value };
}

function setTargetScore(code, byPlayerId, value) {
  const room = getRoom(code);
  if (!room) throw new RoomError('Room not found');
  if (room.hostId !== byPlayerId) throw new RoomError('Only the host can change this');
  if (room.isPublic) throw new RoomError('Quick play games have no target score');
  if (room.game && room.game.phase !== 'ended') throw new RoomError('Wait for this game to finish');
  const n = Number(value);
  if (!TARGET_CHOICES.includes(n)) throw new RoomError('Pick one of the listed targets');
  room.targetScore = n;
  room.matchOver = null;
}

/** Host-only, private rooms with the bots option on: seat a computer player. */
function addBot(code, byPlayerId) {
  const room = getRoom(code);
  if (!room) throw new RoomError('Room not found');
  if (room.hostId !== byPlayerId) throw new RoomError('Only the host can add bots');
  if (room.isPublic) throw new RoomError('Bots can only join private rooms');
  if (room.game && room.game.phase !== 'ended') throw new RoomError('Wait for this game to finish');
  if (room.players.length >= room.maxPlayers) throw new RoomError('This room is full');
  let n = 1;
  while (room.players.some((p) => p.name === `Bot ${n}`)) n++;
  const p = { playerId: `bot-${room.code}-${n}-${Date.now().toString(36)}`, name: `Bot ${n}`, connected: true, bot: true, totalScore: 0, wins: 0 };
  room.players.push(p);
  return p;
}

function removeBot(code, byPlayerId, botId) {
  const room = getRoom(code);
  if (!room) throw new RoomError('Room not found');
  if (room.hostId !== byPlayerId) throw new RoomError('Only the host can remove bots');
  if (room.game && room.game.phase !== 'ended') throw new RoomError('Wait for this game to finish');
  room.players = room.players.filter((p) => !(p.bot && p.playerId === botId));
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
  // Room-level achievements: win streaks and beating a table full of bots.
  const bots = room.players.filter((p) => p.bot && g.players.some((gp) => gp.id === p.playerId)).length;
  for (const p of room.players) {
    if (!g.players.some((gp) => gp.id === p.playerId)) continue;
    const won = g.results.winners.includes(p.playerId);
    p.streak = won ? (p.streak || 0) + 1 : 0;
    if (p.streak >= 3) g.award(p.playerId, 'hattrick');
    if (won && !p.bot && bots >= 7) g.award(p.playerId, 'botbeater');
  }
  // Match to a target score: once anyone reaches it, the lowest total wins.
  if (room.targetScore && room.players.some((p) => p.totalScore >= room.targetScore)) {
    const low = Math.min(...room.players.map((p) => p.totalScore));
    room.matchOver = { winners: room.players.filter((p) => p.totalScore === low).map((p) => p.playerId) };
    for (const id of room.matchOver.winners) g.award(id, room.targetScore >= 100 ? 'ultimate' : 'champion');
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
    room.turnSeconds = QUICK_PLAY_TURN_SECONDS;
    const game = startGame(room.code);
    for (const p of room.players) p.connected = false;
    for (const gp of game.players) {
      gp.connected = false;
      game.awaiting.add(gp.id);
    }
    game.peekDeadline = null; // the peek countdown starts once everyone has arrived
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
    turnSeconds: room.turnSeconds,
    options: room.options,
    turnChoices: TURN_TIMER_CHOICES,
    targetScore: room.targetScore,
    targetChoices: TARGET_CHOICES,
    matchOver: room.matchOver,
    isPublic: !!room.isPublic,
    players: room.players.map((p) => ({
      id: p.playerId,
      name: p.name,
      connected: p.connected,
      totalScore: p.totalScore,
      wins: p.wins,
      bot: !!p.bot,
    })),
    game: room.game ? room.game.view(playerId) : null,
  };
}

function sweep(maxIdleMs = 30 * 60 * 1000) {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyone = room.players.some((p) => p.connected && !p.bot);
    if (!anyone && now - room.lastActive > maxIdleMs) rooms.delete(code);
  }
}

module.exports = {
  rooms, RoomError, createRoom, getRoom, joinRoom, leaveRoom, startGame, setHandSize, setMaxPlayers, setTurnTimer, setOption, setTargetScore, addBot, removeBot,
  createRoomWithPlayers, recordResults, view, sweep, normalizeCode, cleanName,
};
