// Cambrio quick play: a single public queue that groups random players into games.
//
// Pure logic, no networking. The server wires it to sockets (see attachQuickPlay below)
// and supplies onMatch, which should create a room and seat the matched players.
//
// GUESSES (marked so they are easy to change once we see real traffic):
//   - IDEAL_SIZE 4: Cambrio plays best with about 4. Start a game the moment 4 are waiting.
//   - If nobody new joins for 10s, start with whoever is waiting (2 or 3 players). (Briley's rule)
//   - MAX_WAIT 120s: after that the player is told nobody is around and is taken out of the queue
//     (the page offers "keep waiting" or "make a private room instead").
// The oldest waiting player sets the rules for the group, so nobody waits forever behind newcomers.

const DEFAULTS = {
  idealSize: 4,          // GUESS
  minSize: 2,
  relaxSteps: [          // [seconds since the last player joined, smallest game accepted]
    [10, 2],
  ],
  maxWaitSec: 120,       // GUESS
  tickMs: 1000,
};

class Matchmaker {
  constructor({ onMatch, onStatus = () => {}, onTimeout = () => {}, now = Date.now, ...opts } = {}) {
    if (typeof onMatch !== 'function') throw new Error('onMatch is required');
    this.cfg = { ...DEFAULTS, ...opts };
    this.onMatch = onMatch;
    this.onStatus = onStatus;
    this.onTimeout = onTimeout;
    this.now = now;
    this.queue = []; // [{ id, name, joinedAt }], oldest first
    this.lastJoinAt = 0;
    this.timer = null;
  }

  start() {
    if (!this.timer) this.timer = setInterval(() => this.tick(), this.cfg.tickMs);
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  isQueued(id) {
    return this.queue.some((p) => p.id === id);
  }

  join(id, name) {
    if (!id) throw new Error('player id is required');
    if (this.isQueued(id)) return false; // double click or second tab
    this.queue.push({ id, name: String(name || 'Player').slice(0, 20), joinedAt: this.now() });
    this.lastJoinAt = this.now();
    this.tick();
    return true;
  }

  leave(id) {
    const before = this.queue.length;
    this.queue = this.queue.filter((p) => p.id !== id);
    if (this.queue.length !== before) this.broadcastStatus();
    return this.queue.length !== before;
  }

  // Smallest game that may start right now: 4 at once, or fewer once nobody new has joined for a while.
  acceptableSize() {
    if (!this.queue.length) return this.cfg.idealSize;
    const waited = (this.now() - this.lastJoinAt) / 1000;
    let size = this.cfg.idealSize;
    for (const [afterSec, s] of this.cfg.relaxSteps) if (waited >= afterSec) size = Math.min(size, s);
    return Math.max(size, this.cfg.minSize);
  }

  // Seconds until a smaller game starts if nobody else joins, or null when that can't happen yet.
  startsInSec() {
    const n = this.queue.length;
    if (n >= this.cfg.idealSize) return 0;
    const waited = (this.now() - this.lastJoinAt) / 1000;
    let best = null;
    for (const [afterSec, size] of this.cfg.relaxSteps) {
      if (n >= Math.max(size, this.cfg.minSize)) {
        const left = Math.max(0, Math.round((afterSec - waited) * 10) / 10);
        if (best === null || left < best) best = left;
      }
    }
    return best;
  }

  tick() {
    // Drop anyone who has waited too long.
    const t = this.now();
    const expired = this.queue.filter((p) => (t - p.joinedAt) / 1000 >= this.cfg.maxWaitSec);
    if (expired.length) {
      this.queue = this.queue.filter((p) => !expired.includes(p));
      for (const p of expired) this.onTimeout(p);
    }

    // Form as many games as possible, oldest players first.
    while (this.queue.length >= this.acceptableSize()) {
      const size = Math.min(this.queue.length, this.cfg.idealSize);
      const players = this.queue.splice(0, size);
      try {
        this.onMatch(players);
      } catch (err) {
        // Room creation failed: put them back at the front so they keep their place.
        this.queue.unshift(...players);
        console.error('[matchmaking] onMatch failed', err);
        break;
      }
    }
    this.broadcastStatus();
  }

  broadcastStatus() {
    const t = this.now();
    const waiting = this.queue.length;
    const needed = Math.max(0, this.acceptableSize() - waiting);
    const startsInSec = this.startsInSec();
    this.queue.forEach((p, i) => {
      this.onStatus(p.id, {
        waiting,
        position: i + 1,
        waitedSec: Math.floor((t - p.joinedAt) / 1000),
        needed,
        startsInSec,
        idealSize: this.cfg.idealSize,
        maxWaitSec: this.cfg.maxWaitSec,
      });
    });
  }
}

// Socket.IO wiring. Players are keyed by the stable playerId the client keeps in localStorage,
// and messages go to whichever socket that player is currently using.
// createGame(players: [{playerId, name}]) must create a room, seat the players, and return its code
// (in the main server: rooms.createRoomWithPlayers(players, { autoStart: true })).
// Events:
//   client -> server: 'quickplay:join' { name, playerId }, 'quickplay:leave'
//   server -> client: 'quickplay:status' {...}, 'matched' { code, players }, 'quickplay:timeout'
// On 'matched' the client goes to /?room=CODE and joins like any private room.
function attachQuickPlay(io, { createGame, ...opts }) {
  const socketOf = new Map(); // playerId -> socket id
  const send = (playerId, event, data) => {
    const sid = socketOf.get(playerId);
    if (sid) io.to(sid).emit(event, data);
  };
  const mm = new Matchmaker({
    ...opts,
    onMatch(players) {
      const code = createGame(players.map((p) => ({ playerId: p.id, name: p.name })));
      for (const p of players) {
        send(p.id, 'matched', { code, players: players.map((x) => x.name) });
        socketOf.delete(p.id);
      }
    },
    onStatus: (id, status) => send(id, 'quickplay:status', status),
    onTimeout(p) {
      send(p.id, 'quickplay:timeout');
      socketOf.delete(p.id);
    },
  }).start();

  io.on('connection', (socket) => {
    let playerId = null;
    socket.on('quickplay:join', (data = {}) => {
      if (typeof data.playerId !== 'string' || !data.playerId) return;
      playerId = data.playerId.slice(0, 64);
      socketOf.set(playerId, socket.id); // a newer tab takes over the player's place
      if (!mm.join(playerId, data.name)) mm.broadcastStatus();
    });
    const leave = () => {
      if (playerId && socketOf.get(playerId) === socket.id) {
        socketOf.delete(playerId);
        mm.leave(playerId);
      }
    };
    socket.on('quickplay:leave', leave);
    socket.on('disconnect', leave);
  });
  return mm;
}

module.exports = { Matchmaker, attachQuickPlay, DEFAULTS };
