/* Cambrio Online client. Plain JS, no build step. */
(() => {
  'use strict';

  // ---------- storage (shared keys with quickplay.html) ----------
  const mem = {};
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return mem[k] ?? null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { mem[k] = v; } },
  };
  function playerId() {
    let id = store.get('cambioPlayerId');
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
      store.set('cambioPlayerId', id);
    }
    return id;
  }

  // ---------- state ----------
  const socket = io();
  const app = document.getElementById('app');
  const S = {
    room: null,          // room view from the server
    code: null,          // room code we are in
    selected: [],        // [{pid, slot}] chosen for a power
    selectKey: '',       // resets selection when the turn situation changes
    reveals: new Map(),  // "pid:slot" -> {card, until, shown}
    inFlight: new Map(), // data-key -> count of cards flying there (hidden until they land)
    lastFxSeq: null,     // last animation batch we played
    fxRound: null,
    endShownRound: null, // flip everyone's cards once when a round ends
    lastTap: null,       // {key, time} for double-tap to stick
    tapTimer: null,
    lastDiscardId: null, // animate the discard pile only when it changes
    lastDrawnKey: null,
  };

  const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const POWER_TEXT = {
    peekOwn: 'Look at one of your own cards',
    peekOther: "Look at one of another player's cards",
    swap: 'Swap any 2 cards (no looking)',
    lookSwap: 'Look at any 2 cards, then you may swap any 2',
  };
  function powerOf(card) {
    if (!card || card.hidden) return null;
    if (['7', '8'].includes(card.rank)) return 'peekOwn';
    if (['9', '10'].includes(card.rank)) return 'peekOther';
    if (['J', 'Q'].includes(card.rank)) return 'swap';
    if (card.rank === 'K' && (card.suit === 'S' || card.suit === 'C')) return 'lookSwap';
    return null;
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- toast ----------
  let toastTimer;
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
  }

  // ---------- server calls ----------
  function call(event, data) {
    return new Promise((resolve) => {
      socket.timeout(8000).emit(event, data, (err, res) => {
        if (err) { toast('No answer from the server. Check your connection.'); return resolve(null); }
        if (!res.ok) { toast(res.error); return resolve(null); }
        resolve(res);
      });
    });
  }
  const act = (type, extra = {}) => call('action', { type, ...extra });

  async function createRoom(name) {
    store.set('cambioName', name);
    const res = await call('create_room', { name, playerId: playerId() });
    if (res) enterRoom(res.code);
  }
  async function joinRoom(code, name) {
    store.set('cambioName', name);
    const res = await call('join_room', { code, name, playerId: playerId() });
    if (res) enterRoom(res.code);
    else if (!S.code) renderHome(code);
    return res;
  }
  function enterRoom(code) {
    S.code = code;
    const url = new URL(location.href);
    url.searchParams.set('room', code);
    history.replaceState(null, '', url);
  }
  async function leaveRoom() {
    await call('leave_room', {});
    S.code = null; S.room = null;
    history.replaceState(null, '', '/');
    renderHome();
  }

  socket.on('state', (room) => {
    const g = room.game;
    const fx = g && g.fx;
    let events = [];
    if (fx) {
      const sameRound = S.fxRound === room.round && S.lastFxSeq !== null;
      if (sameRound && fx.seq !== S.lastFxSeq && !REDUCED_MOTION && S.room && S.room.game) events = fx.events;
      S.lastFxSeq = fx.seq;
      S.fxRound = room.round;
    }
    if (!events.length) {
      S.room = room;
      render();
      return;
    }
    // Measure where cards start (old layout), hide where they land, re-render, then fly.
    const startRects = new Map();
    for (const ev of events) {
      for (const pl of [ev.from, ev.at].filter(Boolean)) {
        const k = placeKey(pl);
        if (!startRects.has(k)) startRects.set(k, rectOf(k));
      }
    }
    for (const ev of events) {
      if (ev.kind === 'move') hold(placeKey(ev.to));
      if (ev.kind === 'stick') { hold(placeKey(ev.at)); if (ev.ok) hold('discard'); }
    }
    S.room = room;
    render();
    playFx(events, startRects, room.you);
  });
  socket.on('reveal', ({ cards }) => {
    const until = Date.now() + 5000;
    for (const c of cards) S.reveals.set(`${c.pid}:${c.slot}`, { card: c.card, until, shown: false });
    render();
    setTimeout(render, 5100);
  });
  socket.on('matched', ({ code }) => { location.href = `/?room=${encodeURIComponent(code)}`; });
  socket.on('connect', () => {
    if (S.code) call('join_room', { code: S.code, name: store.get('cambioName') || 'Player', playerId: playerId() });
  });
  socket.on('disconnect', () => toast('Connection lost. Reconnecting…'));

  // ---------- animations ----------
  const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const MOVE_MS = 430;
  const EASE = 'cubic-bezier(.2,.8,.2,1)';

  function placeKey(pl) { return pl.zone ? pl.zone : `s:${pl.pid}:${pl.slot}`; }
  function elOf(key) { return app.querySelector(`[data-key="${CSS.escape(key)}"]`); }
  function rectOf(key) { const el = elOf(key); return el ? el.getBoundingClientRect() : null; }
  function hold(key) { S.inFlight.set(key, (S.inFlight.get(key) || 0) + 1); }
  function release(key) {
    const n = (S.inFlight.get(key) || 0) - 1;
    if (n > 0) { S.inFlight.set(key, n); return; }
    S.inFlight.delete(key);
    // Reveal the landed card in place (no full re-render, so clicks in progress aren't lost).
    const el = elOf(key);
    if (!el) return;
    el.classList.remove('in-flight');
    if (el.classList.contains('face')) el.classList.add('flip-in');
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function floatingCard(card, rect) {
    const wrap = document.createElement('div');
    wrap.className = 'flying';
    wrap.style.cssText = `left:${rect.left}px;top:${rect.top}px;--card-w:${rect.width}px`;
    wrap.innerHTML = cardHtml(card || { hidden: true });
    document.body.appendChild(wrap);
    return wrap;
  }

  async function fly(card, fromRect, toKey, delay) {
    if (delay) await wait(delay);
    const to = rectOf(toKey);
    if (!fromRect || !to) return release(toKey);
    const el = floatingCard(card, fromRect);
    const dx = (to.left + to.width / 2) - (fromRect.left + fromRect.width / 2);
    const dy = (to.top + to.height / 2) - (fromRect.top + fromRect.height / 2);
    const sc = to.width / fromRect.width;
    const anim = el.animate([
      { transform: 'translate(0,0) scale(1) rotate(0deg)', boxShadow: '0 2px 6px rgba(0,0,0,.35)' },
      { transform: `translate(${dx / 2}px,${dy / 2 - 24}px) scale(${(1 + sc) / 2 * 1.08}) rotate(-4deg)`, offset: 0.5 },
      { transform: `translate(${dx}px,${dy}px) scale(${sc}) rotate(0deg)` },
    ], { duration: MOVE_MS, easing: EASE, fill: 'forwards' });
    await anim.finished.catch(() => {});
    el.remove();
    release(toKey);
  }

  function setFace(wrap, card) {
    wrap.innerHTML = cardHtml(card || { hidden: true });
  }

  async function stickFx(ev, fromRect, delay) {
    if (delay) await wait(delay);
    const atKey = placeKey(ev.at);
    if (!fromRect) { release(atKey); if (ev.ok) release('discard'); return; }
    const el = floatingCard({ hidden: true }, fromRect);
    const lift = 'translateY(-14px) scale(1.12)';
    await el.animate([{ transform: 'none' }, { transform: lift }], { duration: 140, easing: EASE, fill: 'forwards' }).finished;
    await el.animate([{ transform: lift }, { transform: `${lift} scaleX(0)` }], { duration: 120, fill: 'forwards' }).finished;
    setFace(el, ev.card);
    el.classList.add(ev.ok ? 'stick-ok' : 'stick-bad');
    await el.animate([{ transform: `${lift} scaleX(0)` }, { transform: lift }], { duration: 120, fill: 'forwards' }).finished;
    await wait(420);
    if (ev.ok) {
      const to = rectOf('discard');
      if (to) {
        const dx = (to.left + to.width / 2) - (fromRect.left + fromRect.width / 2);
        const dy = (to.top + to.height / 2) - (fromRect.top + fromRect.height / 2);
        const sc = to.width / fromRect.width;
        await el.animate([{ transform: lift }, { transform: `translate(${dx}px,${dy}px) scale(${sc})` }],
          { duration: 360, easing: EASE, fill: 'forwards' }).finished;
      }
      el.remove();
      release(atKey);
      release('discard');
    } else {
      await el.animate([
        { transform: lift }, { transform: `${lift} translateX(-8px)` }, { transform: `${lift} translateX(8px)` },
        { transform: `${lift} translateX(-6px)` }, { transform: `${lift} translateX(6px)` }, { transform: lift },
      ], { duration: 320, fill: 'forwards' }).finished;
      await el.animate([{ transform: lift }, { transform: `${lift} scaleX(0)` }], { duration: 120, fill: 'forwards' }).finished;
      setFace(el, null);
      el.classList.remove('stick-bad');
      await el.animate([{ transform: `${lift} scaleX(0)` }, { transform: 'none' }], { duration: 180, easing: EASE, fill: 'forwards' }).finished;
      el.remove();
      release(atKey);
    }
  }

  function peekFx(ev, delay) {
    setTimeout(() => {
      for (const pl of ev.at) {
        const el = elOf(placeKey(pl));
        if (el) el.animate([
          { transform: 'none' }, { transform: 'translateY(-12px) rotate(-3deg)', offset: 0.3 },
          { transform: 'translateY(-12px) rotate(-3deg)', offset: 0.7 }, { transform: 'none' },
        ], { duration: 1100, easing: 'ease-in-out' });
      }
    }, delay);
  }

  function playFx(events, startRects) {
    let t = 0;
    for (const ev of events) {
      if (ev.kind === 'move') fly(ev.card, startRects.get(placeKey(ev.from)), placeKey(ev.to), t);
      else if (ev.kind === 'stick') { stickFx(ev, startRects.get(placeKey(ev.at)), t); t += ev.ok ? 1200 : 1350; }
      else if (ev.kind === 'peek') peekFx(ev, t);
    }
  }

  // ---------- cards ----------
  function cardHtml(card, o = {}) {
    const cls = ['card'];
    let inner = '';
    if (card === null) {
      cls.push('empty');
    } else if (!card || card.hidden) {
      cls.push('back');
    } else if (card.rank === 'JOKER') {
      cls.push('face', 'joker');
      inner = '<span class="rank">JOKER</span><span class="pip">🃏</span>';
    } else {
      cls.push('face');
      if (card.suit === 'H' || card.suit === 'D') cls.push('red');
      inner = `<span class="rank">${card.rank}</span><span class="suit-sm">${SUIT[card.suit]}</span><span class="pip">${SUIT[card.suit]}</span>`;
    }
    if (o.ghost) { cls.length = 0; cls.push('card', 'ghost'); inner = ''; }
    if (o.clickable) cls.push('clickable');
    if (o.selected) cls.push('selected');
    if (o.revealed) cls.push('revealed');
    if (o.locked) cls.push('locked');
    if (o.pop) cls.push('pop');
    if (o.flip) cls.push('flip-in');
    if (o.stickable) cls.push('stickable');
    if (o.key && S.inFlight.has(o.key)) cls.push('in-flight');
    if (o.key) o.data = { ...(o.data || {}), key: o.key };
    const data = o.data ? Object.entries(o.data).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('') : '';
    const label = card && !card.hidden ? (card.rank === 'JOKER' ? 'Joker' : card.rank + SUIT[card.suit]) : card === null ? 'empty' : 'face-down card';
    const role = o.clickable ? ' role="button" tabindex="0"' : '';
    return `<div class="${cls.join(' ')}"${data}${role} aria-label="${label}">${inner}</div>`;
  }

  // ---------- home ----------
  function renderHome(prefillCode = '') {
    document.getElementById('roomBadge').hidden = true;
    const name = store.get('cambioName') || '';
    app.innerHTML = `
      <section class="home">
        <div class="hero">
          <div class="hero-cards">
            ${cardHtml({ rank: 'K', suit: 'H' }).replace('class="card', 'style="--r:-10deg" class="card')}
            ${cardHtml({ hidden: true }).replace('class="card', 'style="--r:-3deg" class="card')}
            ${cardHtml({ rank: 'JOKER' }).replace('class="card', 'style="--r:4deg" class="card')}
            ${cardHtml({ rank: '7', suit: 'S' }).replace('class="card', 'style="--r:11deg" class="card')}
          </div>
          <h1>Cambrio</h1>
          <p>Remember your cards. Get the lowest score. Call Cambrio.</p>
        </div>
        <form class="box" id="homeForm" autocomplete="off">
          <label>Your name
            <input id="nameInput" maxlength="20" placeholder="Your name" value="${esc(name)}" required>
          </label>
          <button class="primary" type="submit" data-do="create">Create a private room</button>
          <div class="divider">or join friends with a code</div>
          <div class="join-row">
            <input id="codeInput" maxlength="5" placeholder="CODE" value="${esc(prefillCode)}" aria-label="Room code">
            <button class="secondary" type="button" data-do="join">Join</button>
          </div>
          <div class="divider">or</div>
          <a class="secondary center" href="/quickplay.html" style="text-decoration:none;padding:10px 18px;border-radius:999px;font-weight:600;color:var(--ink);background:rgba(255,255,255,.14)">Quick play with random players</a>
        </form>
      </section>`;
    const nameInput = document.getElementById('nameInput');
    const codeInput = document.getElementById('codeInput');
    const getName = () => {
      const n = nameInput.value.trim();
      if (!n) { toast('Enter your name first'); nameInput.focus(); return null; }
      return n;
    };
    document.getElementById('homeForm').addEventListener('submit', (e) => {
      e.preventDefault();
      if (codeInput.value.trim() && document.activeElement === codeInput) return doJoin();
      const n = getName(); if (n) createRoom(n);
    });
    const doJoin = () => {
      const n = getName(); if (!n) return;
      const code = codeInput.value.trim().toUpperCase();
      if (code.length !== 5) { toast('Room codes are 5 letters'); codeInput.focus(); return; }
      joinRoom(code, n);
    };
    app.querySelector('[data-do="join"]').addEventListener('click', doJoin);
    codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doJoin(); } });
    (prefillCode && name ? codeInput : prefillCode ? nameInput : nameInput).focus();
  }

  // ---------- lobby ----------
  function renderLobby(room) {
    const me = room.you;
    const isHost = room.hostId === me;
    const online = room.players.filter((p) => p.connected).length;
    const link = `${location.origin}/r/${room.code}`;
    app.innerHTML = `
      <section class="lobby">
        <div class="box code-box">
          <div class="muted">Room code</div>
          <div class="code">${esc(room.code)}</div>
          <p class="hint">Send friends the code or the link. They can join from any phone or computer.</p>
          <div class="share-row">
            <button class="primary small" data-do="share">Copy invite link</button>
            <button class="secondary small" data-do="copycode">Copy code</button>
          </div>
        </div>
        <div class="box">
          <ul class="player-list">
            ${room.players.map((p) => `
              <li>
                <span class="dot ${p.connected ? '' : 'off'}"></span>
                <span>${esc(p.name)}${p.id === me ? ' (you)' : ''}</span>
                ${p.id === room.hostId ? '<span class="tag">HOST</span>' : ''}
                ${room.round > 0 ? `<span class="meta">${p.wins} win${p.wins === 1 ? '' : 's'} · ${p.totalScore} pts</span>` : ''}
              </li>`).join('')}
          </ul>
          <div class="option-row">
            <span class="muted">Cards each</span>
            ${isHost
              ? [4, 6].map((n) => `<button class="${room.handSize === n ? 'primary' : 'secondary'} small" data-do="handsize" data-size="${n}" aria-pressed="${room.handSize === n}">${n}</button>`).join('')
              : `<b>${room.handSize}</b>`}
          </div>
          <div class="option-row">
            <label class="muted" for="maxPlayers">Max players</label>
            ${isHost
              ? `<select id="maxPlayers" data-do="maxplayers">${Array.from({ length: room.maxPlayersCap - 1 }, (_, i) => i + 2)
                .map((n) => `<option value="${n}" ${n === room.maxPlayers ? 'selected' : ''} ${n < room.players.length ? 'disabled' : ''}>${n}</option>`).join('')}</select>`
              : `<b>${room.maxPlayers}</b>`}
            <span class="muted">· ${room.players.length} in room</span>
          </div>
          ${isHost
            ? `<button class="primary" data-do="start" ${online < 2 ? 'disabled' : ''}>${online < 2 ? 'Waiting for at least 2 players…' : `Start game with ${online} players`}</button>`
            : `<p class="center muted">Waiting for the host to start the game…</p>`}
          <button class="ghost small" data-do="leave">Leave room</button>
        </div>
      </section>`;
    app.querySelector('[data-do="share"]').onclick = async () => {
      if (navigator.share && matchMedia('(pointer: coarse)').matches) {
        try { await navigator.share({ title: 'Play Cambrio with me', url: link }); return; } catch { /* fall through */ }
      }
      copy(link, 'Invite link copied');
    };
    app.querySelector('[data-do="copycode"]').onclick = () => copy(room.code, 'Code copied');
    const start = app.querySelector('[data-do="start"]');
    if (start) start.onclick = () => call('start_game', {});
    app.querySelector('[data-do="leave"]').onclick = leaveRoom;
    const maxSel = app.querySelector('[data-do="maxplayers"]');
    if (maxSel) maxSel.onchange = () => call('set_max_players', { value: Number(maxSel.value) });
    app.querySelectorAll('[data-do="handsize"]').forEach((b) => {
      b.onclick = () => call('set_hand_size', { size: Number(b.dataset.size) });
    });
  }

  async function copy(text, msg) {
    try { await navigator.clipboard.writeText(text); toast(msg); }
    catch { prompt('Copy this:', text); }
  }

  // ---------- game ----------
  function selectionKey(g) {
    return [g.phase, g.current, g.stage, g.power && g.power.step].join('|');
  }

  function targetMode(g, me) {
    // What can I click right now, and what happens?
    if (g.phase === 'peek') return { kind: 'none' };
    if (g.phase !== 'play') return { kind: 'none' };
    if (g.pendingGive) return { kind: 'give' };
    if (g.current !== me) return { kind: 'none' };
    if (g.stage === 'draw') return { kind: 'draw' };
    if (g.stage === 'hold') return { kind: 'swapDrawn' };
    if (g.stage === 'power') {
      const p = g.power;
      if (p.type === 'peekOwn') return { kind: 'power', need: 1, filter: (pid) => pid === me };
      if (p.type === 'peekOther') return { kind: 'power', need: 1, filter: (pid) => pid !== me };
      return { kind: 'power', need: 2, filter: () => true };
    }
    return { kind: 'none' };
  }

  function seatHtml(g, p, me, mode, isMe) {
    const now = Date.now();
    const revealedFromPower = (g.power && g.power.revealed) || [];
    const cols = p.slots.length > 4 ? 'wide' : '';
    const cards = p.slots.map((c, slot) => {
      let card = c;
      let revealed = false;
      const r = S.reveals.get(`${p.id}:${slot}`);
      let flip = false;
      if (r && r.until > now && c) { card = r.card; revealed = true; if (!r.shown) { r.shown = true; flip = true; } }
      const pr = revealedFromPower.find((x) => x.pid === p.id && x.slot === slot);
      if (pr && c) { card = pr.card; revealed = true; }
      if (g.phase === 'peek' && isMe && c && !c.hidden) revealed = true;
      let clickable = false;
      if (c) {
        if (mode.kind === 'give' || mode.kind === 'swapDrawn') clickable = isMe;
        if (mode.kind === 'power') clickable = mode.filter(p.id);
      }
      const selected = S.selected.some((t) => t.pid === p.id && t.slot === slot);
      const stickable = canStick(g, me, p.id, c);
      if (g.phase === 'ended' && S.endShownRound !== S.room.round) flip = true;
      return `<div class="slot">${cardHtml(card, { clickable, selected, revealed, stickable, flip, key: `s:${p.id}:${slot}`, data: { pid: p.id, slot } })}<div class="card-tag">#${slot + 1}</div></div>`;
    }).join('');
    const tags = [];
    if (g.cambioBy === p.id) tags.push('<span class="tag">CAMBRIO</span>');
    if (g.phase === 'peek' && p.ready) tags.push('<span class="tag" style="background:#4cd187">READY</span>');
    return `
      <div class="seat ${isMe ? 'me' : ''} ${g.current === p.id ? 'turn' : ''} ${p.connected ? '' : 'away'}">
        <div class="seat-head"><span class="dot ${p.connected ? '' : 'off'}"></span>${esc(isMe ? `${p.name} (you)` : p.name)}${p.connected ? '' : ' <span class="muted">· away</span>'} ${tags.join('')}</div>
        <div class="hand ${cols}">${cards}</div>
      </div>`;
  }

  function canStick(g, me, pid, card) {
    return !!(card && g.phase === 'play' && g.discardTop && !g.pendingGive
      && g.players.some((p) => p.id === me));
  }

  function promptHtml(g, me, room) {
    const nameOf = (id) => { const p = g.players.find((x) => x.id === id); return p ? esc(p.name) : '?'; };
    const myTurn = g.current === me;

    if (g.phase === 'peek') {
      const meP = g.players.find((p) => p.id === me);
      if (!meP) return '<div class="msg">Players are peeking at their cards…</div>';
      if (meP.ready) return '<div class="msg">Waiting for everyone to finish peeking…</div>';
      return `<div class="msg">Memorize your <b>bottom ${g.peekCount === 3 ? 'three' : 'two'} cards</b>. They'll flip face down when you're ready.</div>
        <div class="actions"><button class="primary" data-do="ready">I've got them</button></div>`;
    }
    if (g.phase === 'ended') return '';

    if (g.pendingGive) {
      return `<div class="msg">Nice stick! Now tap one of your cards to give to <b>${nameOf(g.pendingGive.to)}</b>.</div>`;
    }

    const last = g.turnsLeft !== null && g.cambioBy ? ` <span class="muted">(final round)</span>` : '';
    if (!myTurn) {
      let what = `Waiting for <b>${nameOf(g.current)}</b>`;
      if (g.stage === 'hold') what = `<b>${nameOf(g.current)}</b> is deciding what to do with their card`;
      if (g.stage === 'power') what = `<b>${nameOf(g.current)}</b> is using a power: ${POWER_TEXT[g.power.type].toLowerCase()}`;
      return `<div class="msg">${what}…${last}</div>`;
    }
    if (g.stage === 'draw') {
      return `<div class="msg"><b>Your turn.</b> Tap the deck to draw a card.${last}</div>
        <div class="actions">
          ${g.cambioBy ? '' : '<button class="danger" data-do="cambio">Call Cambrio</button>'}
        </div>`;
    }
    if (g.stage === 'hold') {
      const p = powerOf(g.drawn);
      return `<div class="msg">Tap one of your cards to swap it, or discard the card.${p ? `<br><span class="muted">Discarding it lets you: ${POWER_TEXT[p].toLowerCase()}.</span>` : ''}</div>
        <div class="actions">
          <button class="primary" data-do="discard">Discard${p ? ' & use power' : ''}</button>
        </div>`;
    }
    if (g.stage === 'power') {
      const pw = g.power;
      let msg = POWER_TEXT[pw.type];
      if (pw.type === 'lookSwap') msg = pw.step === 'look' ? 'Pick any 2 cards to look at' : 'Now pick any 2 cards to swap, or keep things as they are';
      if (pw.type === 'swap') msg = 'Pick any 2 cards to swap (no looking)';
      if (pw.type === 'peekOwn') msg = 'Pick one of your cards to look at';
      if (pw.type === 'peekOther') msg = "Pick another player's card to look at";
      const need = pw.type === 'peekOwn' || pw.type === 'peekOther' ? 1 : 2;
      return `<div class="msg"><b>${msg}.</b> ${need === 2 ? `(${S.selected.length}/2 picked)` : ''}</div>
        <div class="actions">
          ${S.selected.length ? '<button class="ghost small" data-do="clearsel">Clear</button>' : ''}
          <button class="secondary" data-do="skip">${pw.step === 'swap' ? "Don't swap" : 'Skip power'}</button>
        </div>`;
    }
    return '';
  }

  function rankName(c) {
    if (!c) return '';
    return c.rank === 'JOKER' ? 'Joker' : c.rank + SUIT[c.suit];
  }

  function resultsHtml(g, room) {
    if (g.phase !== 'ended' || !g.results) return '';
    const isHost = room.hostId === room.you;
    const winners = g.results.winners;
    const names = g.results.scores.filter((s) => winners.includes(s.id)).map((s) => esc(s.name));
    const rows = [...g.results.scores].sort((a, b) => a.score - b.score).map((s) =>
      `<tr class="${winners.includes(s.id) ? 'win' : ''}"><td>${winners.includes(s.id) ? '🏆 ' : ''}${esc(s.name)}${s.id === g.cambioBy ? ' <span class="muted">(called Cambrio)</span>' : ''}</td><td>${s.score} pts</td></tr>`).join('');
    const online = room.players.filter((p) => p.connected).length;
    return `
      <div class="results">
        <h2>${winners.includes(room.you) ? 'You win!' : `${names.join(' & ')} win${names.length === 1 ? 's' : ''}!`}</h2>
        ${g.results.tieBreak === 'cambio' ? '<p class="muted" style="margin:0">Tie! The Cambrio caller wins ties.</p>' : ''}
        ${g.results.tieBreak === 'lowestCard' ? '<p class="muted" style="margin:0">Tie! Broken by the lowest single card.</p>' : ''}
        <table>${rows}</table>
        <div class="actions" style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
          ${isHost ? `<button class="primary" data-do="again" ${online < 2 ? 'disabled' : ''}>Play again</button>` : '<span class="muted">Waiting for the host to start the next round…</span>'}
          <button class="ghost small" data-do="leave">Leave room</button>
        </div>
      </div>`;
  }

  function renderGame(room) {
    const g = room.game;
    const me = room.you;
    const key = selectionKey(g);
    if (key !== S.selectKey) { S.selected = []; S.selectKey = key; }
    const mode = targetMode(g, me);

    const myIdx = g.players.findIndex((p) => p.id === me);
    const ordered = myIdx === -1 ? g.players : g.players.slice(myIdx + 1).concat(g.players.slice(0, myIdx));
    const opponents = ordered.filter((p) => p.id !== me);
    const mine = g.players[myIdx];

    const myTurn = g.current === me;
    const canDraw = mode.kind === 'draw';
    const drawn = g.drawn;
    const holder = g.players.find((p) => p.id === g.current);
    const discardId = g.discardTop ? g.discardTop.id : null;
    const popDiscard = discardId !== S.lastDiscardId;
    S.lastDiscardId = discardId;
    const drawnKey = drawn ? `${g.current}:${drawn.id ?? 'h'}` : null;
    const popDrawn = drawnKey !== S.lastDrawnKey;
    S.lastDrawnKey = drawnKey;
    const drawnHtml = drawn
      ? `<div class="drawn-slot">${cardHtml(drawn, { pop: popDrawn && !S.inFlight.has('drawn'), revealed: myTurn, key: 'drawn' })}<span>${myTurn ? 'Your card' : `${esc(holder ? holder.name : '')}'s card`}</span></div>`
      : `<div class="drawn-slot">${cardHtml(null, { ghost: true, key: 'drawn' })}<span>&nbsp;</span></div>`;

    const totals = room.players.length && room.round > 1
      ? `<div class="scores"><h3>Room totals</h3><table>${[...room.players].sort((a, b) => a.totalScore - b.totalScore).map((p) => `<tr><td>${esc(p.name)}</td><td>${p.wins}🏆 · ${p.totalScore} pts</td></tr>`).join('')}</table></div>` : '';

    app.innerHTML = `
      <section class="table">
        <div class="play-area">
          <div class="opponents">${opponents.map((p) => seatHtml(g, p, me, mode, false)).join('')}</div>
          <div class="center-row">
            <div class="pile">${g.deckCount ? cardHtml({ hidden: true }, { clickable: canDraw, key: 'deck', data: { do: 'drawdeck' } }) : cardHtml(null, { key: 'deck' })}<span>Deck · ${g.deckCount}</span></div>
            ${drawnHtml}
            <div class="pile">${discardHtml(g, popDiscard)}<span>Discard · ${g.discardCount}</span>${g.phase === 'play' ? '<span class="stick-hint">Double-tap a matching card to stick it</span>' : ''}</div>
          </div>
          ${resultsHtml(g, room)}
          ${g.phase !== 'ended' ? `<div class="prompt">${promptHtml(g, me, room)}</div>` : ''}
          <div class="mine">${mine ? seatHtml(g, mine, me, mode, true) : '<p class="center muted">You are watching this game. You can play from the next round.</p>'}</div>
        </div>
        <aside class="side">
          <div class="log" id="log"><h3>What happened</h3>${g.log.map((l) => `<p>${esc(l.text)}</p>`).join('')}</div>
          ${totals}
          ${g.phase !== 'ended' ? '<button class="ghost small" data-do="leave">Leave room</button>' : ''}
        </aside>
      </section>`;
    const log = document.getElementById('log');
    log.scrollTop = log.scrollHeight;
    if (g.phase === 'ended') S.endShownRound = room.round;
  }

  function discardHtml(g, popDiscard) {
    // While a card is flying to the pile, show the card underneath it.
    if (S.inFlight.has('discard')) {
      return `<div class="discard-stack">${g.discardUnder ? cardHtml(g.discardUnder) : cardHtml(null)}${cardHtml(g.discardTop, { key: 'discard' }).replace('class="card', 'class="card stack-top')}</div>`;
    }
    return g.discardTop ? cardHtml(g.discardTop, { pop: popDiscard, key: 'discard' }) : cardHtml(null, { key: 'discard' });
  }

  // ---------- clicks ----------
  app.addEventListener('click', (e) => {
    const el = e.target.closest('[data-do], [data-pid]');
    if (!el || !S.room) return;
    const g = S.room.game;
    const d = el.dataset.do;
    if (d === 'ready') return act('ready');
    if (d === 'drawdeck' && el.classList.contains('clickable')) return act('draw_deck');
    if (d === 'discard') return act('discard');
    if (d === 'cambio') {
      if (confirmCambio()) act('call_cambio');
      return;
    }
    if (d === 'skip') return act('skip_power');
    if (d === 'clearsel') { S.selected = []; return render(); }
    if (d === 'again') return call('start_game', {});
    if (d === 'leave') { if (window.confirm('Leave this room?')) leaveRoom(); return; }

    if (el.dataset.pid !== undefined && g) {
      const t = { pid: el.dataset.pid, slot: Number(el.dataset.slot) };
      const key = `s:${t.pid}:${t.slot}`;
      const now = performance.now();
      // Second tap on the same card quickly: stick it.
      if (S.lastTap && S.lastTap.key === key && now - S.lastTap.time < 350) {
        clearTimeout(S.tapTimer);
        S.lastTap = null;
        if (el.classList.contains('stickable')) act('stick', { target: t });
        return;
      }
      S.lastTap = { key, time: now };
      if (!el.classList.contains('clickable')) return;
      const run = () => singleTap(g, t);
      // If this card could also be stuck, wait a moment to see if a second tap is coming.
      if (el.classList.contains('stickable')) { clearTimeout(S.tapTimer); S.tapTimer = setTimeout(run, 260); }
      else run();
    }
  });

  function singleTap(g0, t) {
    const g = S.room && S.room.game;
    if (!g) return;
    const mode = targetMode(g, S.room.you);
    if (mode.kind === 'give') return act('give', { slot: t.slot });
    if (mode.kind === 'swapDrawn') return act('swap', { slot: t.slot });
    if (mode.kind === 'power') {
      if (!mode.filter(t.pid)) return;
      const i = S.selected.findIndex((x) => x.pid === t.pid && x.slot === t.slot);
      if (i >= 0) S.selected.splice(i, 1); else S.selected.push(t);
      if (S.selected.length >= mode.need) {
        const targets = S.selected.slice(0, mode.need);
        S.selected = [];
        act('power_pick', { targets });
      }
      render();
    }
  }
  app.addEventListener('dblclick', (e) => e.preventDefault());
  app.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.card.clickable')) { e.preventDefault(); e.target.click(); }
  });

  function confirmCambio() {
    return window.confirm('Call Cambrio? Everyone else gets one more turn, then all cards are revealed.');
  }

  // ---------- render ----------
  function render() {
    if (!S.room) return;
    const badge = document.getElementById('roomBadge');
    badge.hidden = false;
    badge.innerHTML = `Room <b>${esc(S.room.code)}</b>`;
    if (!S.room.game) renderLobby(S.room);
    else renderGame(S.room);
  }

  document.getElementById('rulesBtn').onclick = () => document.getElementById('rulesDialog').showModal();

  // ---------- boot ----------
  const params = new URLSearchParams(location.search);
  const codeParam = (params.get('room') || '').toUpperCase();
  const savedName = store.get('cambioName');
  if (codeParam && savedName) {
    app.innerHTML = '<p class="center muted" style="margin-top:60px">Joining room…</p>';
    joinRoom(codeParam, savedName);
  } else {
    renderHome(codeParam);
  }
})();
