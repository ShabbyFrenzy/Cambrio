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
    noteMode: false,     // hard mode: making a note
    noteInfo: { is: [], not: [], knows: [] }, // what the note will say
    noteSel: [],         // [{pid, slot}] cards the note goes on
    flash: new Map(),    // data-key -> {kind:'look'|'swap', until}
    selectKey: '',       // resets selection when the turn situation changes
    reveals: new Map(),  // "pid:slot" -> {card, until, shown}
    inFlight: new Map(), // data-key -> count of cards flying there (hidden until they land)
    lastFxSeq: null,     // last animation batch we played
    fxRound: null,
    endShownRound: null, // flip everyone's cards once when a round ends
    confirm: null,       // {kind:'cambio'|'leave', until} for in-game "are you sure?"
    closingDeadline: null, // local time when the end-of-round sticking window closes
    turnDeadline: null,  // local time when the current turn runs out
    turnFrozen: null,    // ms left while the game is paused
    turnKey: '',
    lastDiscardId: null, // animate the discard pile only when it changes
    lastDrawnKey: null,
  };

  // \uFE0E asks for the plain text symbol, so no device swaps in a coloured emoji.
  const SUIT = { S: '♠\uFE0E', H: '♥\uFE0E', D: '♦\uFE0E', C: '♣\uFE0E' };
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
    store.set('cambrioLastRoom', code);
    const url = new URL(location.href);
    url.searchParams.set('room', code);
    history.replaceState(null, '', url);
  }
  async function leaveRoom() {
    await call('leave_room', {});
    S.code = null; S.room = null;
    store.set('cambrioLastRoom', '');
    history.replaceState(null, '', '/');
    renderHome();
  }

  socket.on('state', (room) => {
    const g = room.game;
    if (g && g.earned && g.earned.length) noteEarned(g.earned);
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
  socket.on('reaction', ({ pid, emoji }) => {
    if (REDUCED_MOTION) return;
    const seat = document.querySelector(`[data-seat="${CSS.escape(pid)}"] .seat-head`);
    if (!seat) return;
    const r = seat.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'reaction-float';
    el.textContent = emoji;
    el.style.left = `${r.left + Math.min(r.width, 160) / 2}px`;
    el.style.top = `${r.top}px`;
    document.body.appendChild(el);
    el.animate([{ transform: 'translate(-50%,0) scale(.6)', opacity: 0 }, { transform: 'translate(-50%,-20px) scale(1.2)', opacity: 1, offset: 0.2 }, { transform: 'translate(-50%,-90px) scale(1)', opacity: 0 }],
      { duration: 1800, easing: 'ease-out', fill: 'forwards' }).finished.then(() => el.remove());
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

  function stickTimeBadge(ms, rect) {
    const el = document.createElement('div');
    el.className = 'stick-time';
    el.textContent = `⚡ ${(ms / 1000).toFixed(2)}s`;
    el.style.left = `${rect.left + rect.width / 2}px`;
    el.style.top = `${rect.top - 8}px`;
    document.body.appendChild(el);
    el.animate([{ opacity: 0, transform: 'translate(-50%,0)' }, { opacity: 1, transform: 'translate(-50%,-18px)', offset: 0.15 }, { opacity: 1, transform: 'translate(-50%,-24px)', offset: 0.8 }, { opacity: 0, transform: 'translate(-50%,-34px)' }],
      { duration: 2200, fill: 'forwards' }).finished.then(() => el.remove());
  }

  // ---------- round replay ----------
  // Steps through snapshots of the table (every card face up) taken after each log line.
  function openReplay(steps, players) {
    let dlg = document.getElementById('replayDialog');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'replayDialog';
      dlg.className = 'replay';
      document.body.appendChild(dlg);
    }
    let i = 0;
    let timer = null;
    const nameOf = (id) => { const p = players.find((x) => x.id === id); return p ? esc(p.name) : '?'; };
    const stop = () => { clearInterval(timer); timer = null; };
    const draw = () => {
      const st = steps[i];
      dlg.innerHTML = `
        <div class="replay-head"><h2>Round replay</h2><button class="ghost small" data-r="close" aria-label="Close replay">✕</button></div>
        <p class="replay-step"><span class="muted">Step ${i + 1} of ${steps.length}</span><br>${esc(st.text)}</p>
        <div class="replay-table">
          ${st.hands.map((h) => `<div class="replay-seat"><b>${nameOf(h.id)}</b><div class="replay-hand ${h.cards.length > 4 ? 'wide' : ''}">${h.cards.map((c) => (c ? cardHtml(c) : cardHtml(null))).join('')}</div></div>`).join('')}
          <div class="replay-seat"><b>Discard</b><div class="replay-pile">${st.top ? cardHtml(st.top) : cardHtml(null, { ghost: true })}</div></div>
          ${st.drawn ? `<div class="replay-seat"><b>Drawn</b><div class="replay-pile">${cardHtml(st.drawn)}</div></div>` : ''}
        </div>
        <input type="range" min="0" max="${steps.length - 1}" value="${i}" data-r="seek" aria-label="Replay position">
        <div class="replay-controls">
          <button class="secondary small" data-r="first" aria-label="First step">⏮</button>
          <button class="secondary small" data-r="prev" ${i === 0 ? 'disabled' : ''}>◀ Back</button>
          <button class="primary small" data-r="play">${timer ? '❚❚ Pause' : '▶ Play'}</button>
          <button class="secondary small" data-r="next" ${i === steps.length - 1 ? 'disabled' : ''}>Next ▶</button>
          <button class="secondary small" data-r="last" aria-label="Last step">⏭</button>
        </div>`;
    };
    const go = (n) => { i = Math.max(0, Math.min(steps.length - 1, n)); if (i === steps.length - 1) stop(); draw(); };
    dlg.onclick = (e) => {
      const b = e.target.closest('[data-r]');
      if (!b) { if (e.target === dlg) { stop(); dlg.close(); } return; }
      const r = b.dataset.r;
      if (r === 'close') { stop(); dlg.close(); }
      if (r === 'first') { stop(); go(0); }
      if (r === 'last') { stop(); go(steps.length - 1); }
      if (r === 'prev') { stop(); go(i - 1); }
      if (r === 'next') { stop(); go(i + 1); }
      if (r === 'play') {
        if (timer) { stop(); draw(); return; }
        if (i === steps.length - 1) i = 0;
        timer = setInterval(() => go(i + 1), 1300);
        draw();
      }
    };
    dlg.oninput = (e) => { if (e.target.dataset.r === 'seek') { stop(); go(Number(e.target.value)); } };
    dlg.onclose = stop;
    draw();
    dlg.showModal();
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
    if (ev.ok && typeof ev.ms === 'number') stickTimeBadge(ev.ms, fromRect);
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

  // Someone called Cambrio: a big "CAMBRIO!" pops up in the middle of the screen,
  // then shrinks and flies onto the caller's seat, where the CAMBRIO tag stays.
  async function cambioFx(ev) {
    const g = S.room && S.room.game;
    const who = ev.by === (S.room && S.room.you) ? 'You' : nameIn(g || { players: [] }, ev.by);
    S.cambioFlying = true;
    document.querySelectorAll('.cambio-tag').forEach((t) => { t.style.visibility = 'hidden'; });
    const el = document.createElement('div');
    el.className = 'cambio-pop';
    el.innerHTML = `<b>CAMBRIO!</b><span>${who} called it</span>`;
    document.body.appendChild(el);
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    try {
      await el.animate([
        { transform: 'translate(-50%, -50%) scale(.3) rotate(-8deg)', opacity: 0 },
        { transform: 'translate(-50%, -50%) scale(1.15) rotate(2deg)', opacity: 1, offset: 0.6 },
        { transform: 'translate(-50%, -50%) scale(1) rotate(0)', opacity: 1 },
      ], { duration: reduce ? 1 : 500, easing: 'cubic-bezier(.2,.9,.3,1.3)', fill: 'forwards' }).finished;
      await wait(reduce ? 900 : 1100);
      const seat = document.querySelector(`[data-seat="${CSS.escape(ev.by)}"]`);
      const tag = seat && (seat.querySelector('.cambio-tag') || seat.querySelector('.seat-head'));
      if (tag) {
        const r = tag.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        const dx = r.left + r.width / 2 - (box.left + box.width / 2);
        const dy = r.top + r.height / 2 - (box.top + box.height / 2);
        const scale = Math.max(0.12, r.width / box.width);
        await el.animate([
          { transform: 'translate(-50%, -50%) scale(1)', opacity: 1 },
          { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(${scale})`, opacity: 0.6 },
        ], { duration: reduce ? 1 : 650, easing: 'cubic-bezier(.5,0,.3,1)', fill: 'forwards' }).finished;
      }
    } finally {
      el.remove();
      S.cambioFlying = false;
      document.querySelectorAll('.cambio-tag').forEach((t) => { t.style.visibility = ''; t.classList.add('pop'); });
    }
  }

  // Cards someone looked at or swapped glow for a few seconds so nobody misses it.
  const FLASH_MS = 4000;
  function flashCards(places, kind, delay) {
    setTimeout(() => {
      const until = Date.now() + FLASH_MS;
      for (const pl of places) S.flash.set(placeKey(pl), { kind, until });
      render();
      setTimeout(render, FLASH_MS + 50);
    }, delay);
  }

  function playFx(events, startRects) {
    let t = 0;
    for (const ev of events) {
      if (ev.kind === 'move') fly(ev.card, startRects.get(placeKey(ev.from)), placeKey(ev.to), t);
      else if (ev.kind === 'stick') { stickFx(ev, startRects.get(placeKey(ev.at)), t); t += ev.ok ? 1200 : 1350; }
      else if (ev.kind === 'peek') { peekFx(ev, t); flashCards(ev.at, 'look', t); }
      else if (ev.kind === 'swapped') flashCards(ev.at, 'swap', t + 650);
      else if (ev.kind === 'cambio') cambioFx(ev);
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
    if (card && card.known) cls.push('known'); // easy mode: a card you have seen before
    if (card && card.note) inner += noteHtml(card.note);
    if (o.ghost) { cls.length = 0; cls.push('card', 'ghost'); inner = ''; }
    if (o.clickable) cls.push('clickable');
    if (o.selected) cls.push('selected');
    if (o.notePick) cls.push('note-pick');
    const fl = o.key && S.flash.get(o.key);
    if (fl && fl.until > Date.now()) {
      cls.push(fl.kind === 'look' ? 'flash-look' : 'flash-swap');
      inner += `<span class="flash-badge">${fl.kind === 'look' ? '👁' : '⇄'}</span>`;
    }
    if (o.revealed) cls.push('revealed');
    if (o.locked) cls.push('locked');
    if (o.pop) cls.push('pop');
    if (o.flip) cls.push('flip-in');
    if (o.key && S.inFlight.has(o.key)) cls.push('in-flight');
    if (o.key) o.data = { ...(o.data || {}), key: o.key };
    const data = o.data ? Object.entries(o.data).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('') : '';
    const label = card && !card.hidden ? (card.rank === 'JOKER' ? 'Joker' : card.rank + SUIT[card.suit]) : card === null ? 'empty' : 'face-down card';
    const role = o.clickable ? ' role="button" tabindex="0"' : '';
    return `<div class="${cls.join(' ')}"${data}${role} aria-label="${label}">${inner}</div>`;
  }

  // Hard mode notes: ranks a card is (green) or isn't (red, crossed out).
  // Lowest to highest value: red K (-1), Joker (0), A ... Q, black K (13).
  const NOTE_RANKS = ['K-red', 'JOKER', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K-black'];
  const byValue = (ranks) => ranks.slice().sort((a, b) => NOTE_RANKS.indexOf(a) - NOTE_RANKS.indexOf(b));
  // Kings carry a bigger suit symbol so a small spade can't be mistaken for a diamond.
  const rankShort = (r) => ({ JOKER: 'Jk', 'K-red': `K<span class="ks">${SUIT.H}</span>`, 'K-black': `K<span class="ks">${SUIT.S}</span>` }[r] || r);
  function noteHtml(note) {
    const is = byValue(note.is || []).map((r) => `<i class="is">${rankShort(r)}</i>`).join('');
    const not = byValue(note.not || []).map((r) => `<i class="not">${rankShort(r)}</i>`).join('');
    const g = S.room && S.room.game;
    const who = (note.knows || []).map((id) => {
      const p = g && g.players.find((x) => x.id === id);
      const name = !p ? '?' : id === S.room.you ? 'You' : p.name;
      return `<i class="knows" title="${esc(name)} knows this card">${esc(name.slice(0, 2))}</i>`;
    }).join('');
    return `${who ? `<span class="knows-row" aria-label="Known by">👁${who}</span>` : ''}${is || not ? `<span class="note">${is}${not}</span>` : ''}`;
  }

  // ---------- home ----------
  function renderHome(prefillCode = '') {
    document.body.classList.remove('ingame');
    document.getElementById('roomBadge').hidden = true;
    const name = store.get('cambioName') || '';
    const lastRoom = store.get('cambrioLastRoom') || '';
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
        ${lastRoom ? `<div class="box rejoin"><span>You were in room <b>${esc(lastRoom)}</b>.</span><button class="primary small" type="button" data-do="rejoin">Rejoin</button></div>` : ''}
        <div class="home-links">
          <button class="secondary" type="button" data-do="tutorial">📖 How to play (tutorial)</button>
          <button class="secondary" type="button" data-do="achievements">🏆 Achievements · ${Object.keys(unlocked()).filter((k) => ACH_BY_ID[k]).length}/${ACHIEVEMENTS.length}</button>
        </div>
        <div class="box customise">
          <h3>Customise</h3>
          <span class="muted">Card back</span>
          <div class="swatches">${CARD_BACKS.map(([k, label]) => `<button type="button" class="swatch back-swatch ${look.back === k ? 'on' : ''}" data-do="setback" data-v="${k}" aria-pressed="${look.back === k}" title="${label}"><span class="card back" data-back="${k}"></span><small>${label}</small></button>`).join('')}</div>
          <span class="muted">Table</span>
          <div class="swatches">${TABLES.map(([k, label]) => `<button type="button" class="swatch table-swatch ${look.table === k ? 'on' : ''}" data-do="settable" data-v="${k}" aria-pressed="${look.table === k}" title="${label}"><span class="felt" data-table="${k}"></span><small>${label}</small></button>`).join('')}</div>
        </div>
      </section>`;
    app.querySelectorAll('[data-do="setback"]').forEach((b) => { b.onclick = () => { setLook('back', b.dataset.v); renderHome(codeInput.value); }; });
    app.querySelectorAll('[data-do="settable"]').forEach((b) => { b.onclick = () => { setLook('table', b.dataset.v); renderHome(codeInput.value); }; });
    app.querySelector('[data-do="tutorial"]').onclick = () => openTutorial();
    app.querySelector('[data-do="achievements"]').onclick = () => openAchievements();
    const rejoinBtn = app.querySelector('[data-do="rejoin"]');
    if (rejoinBtn) rejoinBtn.onclick = () => { const n = nameInput.value.trim() || store.get('cambioName') || 'Player'; joinRoom(lastRoom, n).then((res) => { if (!res) { store.set('cambrioLastRoom', ''); renderHome(); } }); };
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
                ${p.bot ? '<span class="tag bot-tag">BOT</span>' : ''}
                ${p.bot && isHost ? `<button class="ghost tiny" data-do="removebot" data-id="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">✕</button>` : ''}
                ${room.round > 0 ? `<span class="meta">${p.wins} win${p.wins === 1 ? '' : 's'} · ${p.totalScore} pts</span>` : ''}
              </li>`).join('')}
          </ul>
          ${isHost && !room.isPublic
            ? `<button class="secondary small add-bot" data-do="addbot" ${room.players.length >= room.maxPlayers ? 'disabled' : ''}>+ Add a bot</button>` : ''}
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
          <div class="option-row">
            <label class="muted" for="turnTimer">Turn timer</label>
            ${isHost
              ? `<select id="turnTimer" data-do="turntimer">${room.turnChoices.map((n) => `<option value="${n}" ${n === room.turnSeconds ? 'selected' : ''}>${n ? `${n} seconds` : 'Off'}</option>`).join('')}</select>`
              : `<b>${room.turnSeconds ? `${room.turnSeconds} seconds` : 'Off'}</b>`}
          </div>
          ${room.isPublic ? '' : `<div class="option-row">
            <label class="muted" for="targetScore">Play to</label>
            ${isHost
              ? `<select id="targetScore" data-do="target">${room.targetChoices.map((n) => `<option value="${n}" ${n === room.targetScore ? 'selected' : ''}>${n ? `${n} points` : 'No target (single rounds)'}</option>`).join('')}</select>`
              : `<b>${room.targetScore ? `${room.targetScore} points` : 'No target'}</b>`}
          </div>`}
          ${room.isPublic ? '' : `<div class="game-options">
            <span class="muted">Game options</span>
            ${GAME_OPTIONS.map(([k, label, note]) => `<label class="toggle">
              <input type="checkbox" data-do="option" data-key="${k}" ${room.options && room.options[k] ? 'checked' : ''} ${isHost ? '' : 'disabled'}>
              <span><b>${label}</b><small>${note}</small></span>
            </label>`).join('')}
          </div>`}
          <p class="center muted small-note">${room.targetScore && !room.isPublic ? `Rounds keep going until someone reaches ${room.targetScore} points. Then the lowest total wins the match. ` : ''}${room.turnSeconds
            ? `Each turn has ${room.turnSeconds} seconds. After the last turn there are ${room.turnSeconds} seconds to stick.`
            : 'No turn timer. After the last turn, the round ends when everyone presses "No more sticks".'}</p>
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
    const timerSel = app.querySelector('[data-do="turntimer"]');
    if (timerSel) timerSel.onchange = () => call('set_turn_timer', { value: Number(timerSel.value) });
    const targetSel = app.querySelector('[data-do="target"]');
    if (targetSel) targetSel.onchange = () => call('set_target_score', { value: Number(targetSel.value) });
    const addBot = app.querySelector('[data-do="addbot"]');
    if (addBot) addBot.onclick = () => call('add_bot', {});
    app.querySelectorAll('[data-do="removebot"]').forEach((b) => { b.onclick = () => call('remove_bot', { id: b.dataset.id }); });
    app.querySelectorAll('[data-do="option"]').forEach((b) => {
      b.onchange = () => call('set_option', { key: b.dataset.key, value: b.checked });
    });
    app.querySelectorAll('[data-do="handsize"]').forEach((b) => {
      b.onclick = () => call('set_hand_size', { size: Number(b.dataset.size) });
    });
  }

  const GAME_OPTIONS = [
    ['remember', 'Photographic memory', 'Cards you have seen stay face up for you.'],
    ['notes', 'Card notes', "Mark what a card is or isn't, and who knows it."],
    ['counter', 'Card counter', "See how many of each card haven't been discarded."],
  ];
  const REACTIONS = ['😂', '😮', '😡', '👏', '😭', '🔥'];
  const opt = (g, k) => !!(g.options && g.options[k]);

  async function copy(text, msg) {
    try { await navigator.clipboard.writeText(text); toast(msg); }
    catch { prompt('Copy this:', text); }
  }

  // ---------- game ----------
  // Interaction model: tap cards to select them (highlighted), then press a
  // button in the action panel. Buttons are always shown and greyed out when
  // they can't be used.

  function nameIn(g, id) {
    const p = g.players.find((x) => x.id === id);
    return p ? esc(p.name) : '?';
  }

  function cardAtView(g, t) {
    const p = g.players.find((x) => x.id === t.pid);
    return p ? p.slots[t.slot] : null;
  }

  /** What each action button does right now. */
  function actionState(g, me) {
    const amPlayer = g.players.some((p) => p.id === me);
    const playing = g.phase === 'play' && amPlayer;
    const owing = (g.owing || []);
    const paused = owing.length > 0;
    const myTurn = playing && g.current === me && !paused;
    const sel = S.selected;
    const oneOwn = sel.length === 1 && sel[0].pid === me;
    const pw = g.power;
    let power = { label: 'Use power', enabled: false };
    if (myTurn && g.stage === 'power' && pw) {
      if (pw.type === 'peekOwn') power = { label: 'Look', enabled: oneOwn };
      else if (pw.type === 'peekOther') power = { label: 'Look', enabled: sel.length === 1 && sel[0].pid !== me };
      else if (pw.type === 'lookSwap' && pw.step === 'look') power = { label: 'Look', enabled: sel.length === 2 };
      else power = { label: 'Swap cards', enabled: sel.length === 2 };
    }
    return {
      draw: myTurn && g.stage === 'draw',
      swap: myTurn && g.stage === 'hold' && oneOwn,
      discard: myTurn && g.stage === 'hold',
      power,
      skip: { enabled: myTurn && g.stage === 'power', label: pw && pw.step === 'swap' ? "Don't swap" : 'Skip' },
      give: playing && !!g.pendingGive && oneOwn,
      stick: playing && !paused && !!g.discardTop && sel.length === 1 && !!cardAtView(g, sel[0]),
      cambio: myTurn && g.stage === 'draw' && !g.cambioBy,
      // At the very end with no timer, the Cambrio button becomes "No more sticks".
      done: playing && !paused && g.stage === 'closing' && !(g.doneSticking || []).includes(me),
    };
  }

  function needsTwo(g, me) {
    const pw = g.power;
    return g.phase === 'play' && g.current === me && g.stage === 'power' && !!pw && (pw.type === 'swap' || pw.type === 'lookSwap');
  }

  function confirming(kind) {
    return S.confirm && S.confirm.kind === kind && S.confirm.until > Date.now();
  }

  function panelHtml(g, me) {
    const a = actionState(g, me);
    const btn = (doName, label, enabled, cls = 'secondary', extra = '') =>
      `<button class="${cls} act" data-do="${doName}" ${enabled ? '' : 'disabled'} ${extra}>${label}</button>`;
    const sure = confirming('cambio');
    return `
      <div class="action-panel" role="group" aria-label="Actions">
        ${btn('draw', 'Draw', a.draw)}
        ${btn('swap', 'Swap', a.swap)}
        ${btn('discard', g.stage === 'hold' && g.current === me && powerOf(g.drawn) ? 'Discard + power' : 'Discard', a.discard)}
        ${btn('power', a.power.label, a.power.enabled)}
        ${btn('skip', a.skip.label, a.skip.enabled)}
        ${btn('give', 'Give', a.give, a.give ? 'primary' : 'secondary')}
        ${opt(g, 'notes') ? `${btn('stick', 'Stick', a.stick, 'primary')}${btn('note', '✎ Note', true, 'secondary note-btn')}` : btn('stick', 'Stick', a.stick, 'primary wide')}
        ${g.stage === 'closing'
          ? btn('done', (g.doneSticking || []).includes(me) ? 'Waiting for others…' : 'No more sticks', a.done, 'primary wide')
          : btn('cambio', sure ? 'Sure? Tap again' : 'Call Cambrio', a.cambio, `danger wide ${sure ? 'pulse' : ''}`)}
      </div>`;
  }

  function seatHtml(g, p, me, isMe) {
    const now = Date.now();
    const revealedFromPower = (g.power && g.power.revealed) || [];
    const cols = p.slots.length > 4 ? 'wide' : '';
    const selectable = g.phase === 'play' && g.players.some((x) => x.id === me);
    // Opponents' hands are turned round, as if you sat across the table from them:
    // their bottom row (the one they peeked at) is the top row from where you sit.
    const order = p.slots.map((_, i) => i);
    if (!isMe) order.reverse();
    const cards = order.map((slot) => [p.slots[slot], slot]).map(([c, slot]) => {
      let card = c;
      let revealed = false;
      const r = S.reveals.get(`${p.id}:${slot}`);
      let flip = false;
      if (r && r.until > now && c) { card = r.card; revealed = true; if (!r.shown) { r.shown = true; flip = true; } }
      const pr = revealedFromPower.find((x) => x.pid === p.id && x.slot === slot);
      if (pr && c) { card = pr.card; revealed = true; }
      if (g.phase === 'peek' && isMe && c && !c.hidden) revealed = true;
      const selected = S.selected.some((t) => t.pid === p.id && t.slot === slot);
      const notePick = S.noteMode && S.noteSel.some((t) => t.pid === p.id && t.slot === slot);
      if (g.phase === 'ended' && S.endShownRound !== S.room.round) flip = true;
      return `<div class="slot">${cardHtml(card, { clickable: selectable && !!c, selected, notePick, revealed, flip, key: `s:${p.id}:${slot}`, data: { pid: p.id, slot } })}<div class="card-tag">#${slot + 1}</div></div>`;
    }).join('');
    const timerOn = g.current === p.id && g.turnMsLeft !== null && g.turnMsLeft !== undefined;
    const tags = [];
    if (g.cambioBy === p.id) tags.push(`<span class="tag cambio-tag" ${S.cambioFlying ? 'style="visibility:hidden"' : ''}>CAMBRIO</span>`);
    if (g.phase === 'peek' && p.ready) tags.push('<span class="tag" style="background:#4cd187">READY</span>');
    return `
      <div data-seat="${esc(p.id)}" class="seat ${isMe ? 'me' : ''} ${g.current === p.id ? 'turn' : ''} ${p.connected ? '' : 'away'}">
        <div class="seat-head"><span class="dot ${p.connected ? '' : 'off'}"></span>${esc(isMe ? `${p.name} (you)` : p.name)}${p.connected ? '' : ' <span class="muted">· away</span>'} ${tags.join('')}${timerOn ? `<span class="turn-secs">${Math.ceil(turnLeft() / 1000)}s</span>` : ''}</div>
        <div class="hand ${cols}">${cards}</div>
        <div class="turn-bar ${timerOn ? '' : 'off'}"><div class="turn-fill" style="width:${timerOn ? turnPct() : 0}%"></div></div>
      </div>`;
  }

  function promptHtml(g, me) {
    const nameOf = (id) => nameIn(g, id);
    const myTurn = g.current === me;
    const n = S.selected.length;

    if (g.phase === 'peek') {
      const meP = g.players.find((p) => p.id === me);
      const secs = g.peekMsLeft !== null && g.peekMsLeft !== undefined
        ? ` Cards flip face down in <b class="peek-countdown">${Math.ceil(peekLeft() / 1000)}</b>s.` : '';
      if (!meP) return `<div class="msg">Players are peeking at their cards…${secs}</div>`;
      if (meP.ready) return `<div class="msg">Waiting for everyone to finish peeking…${secs}</div>`;
      return `<div class="msg">Memorize your <b>bottom ${g.peekCount === 3 ? 'three' : 'two'} cards</b>.${secs || " They'll flip face down when you're ready."}</div>
        <div class="actions"><button class="primary" data-do="ready">I've got them</button></div>`;
    }
    if (g.phase === 'ended') return '';

    if (g.pendingGive) {
      return `<div class="msg"><b>Nice stick!</b> Everyone waits while you pick one of your cards, then press <b>Give</b> to hand it to <b>${nameOf(g.pendingGive.to)}</b>.</div>`;
    }
    if (g.owing && g.owing.length) {
      return `<div class="msg">Paused: waiting for <b>${nameOf(g.owing[0])}</b> to give a card…</div>`;
    }
    if (g.stage === 'closing') {
      if (g.closingMsLeft === null) {
        const done = (g.doneSticking || []).length;
        const total = g.players.filter((p) => p.connected).length;
        return `<div class="msg"><b>Last chance to stick!</b> Press <b>No more sticks</b> when you're done. Cards are revealed when everyone has (${done} of ${total}).</div>`;
      }
      const done = (g.doneSticking || []).length;
      const total = g.players.filter((p) => p.connected).length;
      return `<div class="msg"><b>Last chance to stick!</b> Cards are revealed in <b class="countdown">${Math.ceil(closingLeft() / 1000)}</b>, or sooner once everyone presses <b>No more sticks</b> (${done} of ${total}).</div>`;
    }
    const stickTip = '<br><span class="muted">Spot a match on the pile? Select that card and press Stick.</span>';
    const last = g.cambioBy ? ' <span class="muted">(final round)</span>' : '';
    if (!myTurn) {
      let what = `Waiting for <b>${nameOf(g.current)}</b>`;
      if (g.stage === 'hold') what = `<b>${nameOf(g.current)}</b> is deciding what to do with their card`;
      if (g.stage === 'power') what = `<b>${nameOf(g.current)}</b> is using a power: ${POWER_TEXT[g.power.type].toLowerCase()}`;
      return `<div class="msg">${what}…${last}${stickTip}</div>`;
    }
    if (g.stage === 'draw') {
      return `<div class="msg"><b>Your turn.</b> Press Draw (or tap the deck), or call Cambrio.${last}</div>`;
    }
    if (g.stage === 'hold') {
      const p = powerOf(g.drawn);
      return `<div class="msg">Select one of your cards and press <b>Swap</b>, or press <b>Discard</b>.${p ? `<br><span class="muted">Discarding it lets you: ${POWER_TEXT[p].toLowerCase()}.</span>` : ''}</div>`;
    }
    if (g.stage === 'power') {
      const pw = g.power;
      let msg = '';
      if (pw.type === 'peekOwn') msg = 'Select one of your cards, then press <b>Look</b>';
      if (pw.type === 'peekOther') msg = "Select another player's card, then press <b>Look</b>";
      if (pw.type === 'swap') msg = `Select any 2 cards (${n}/2), then press <b>Swap cards</b>`;
      if (pw.type === 'lookSwap') {
        msg = pw.step === 'look'
          ? `Select any 2 cards to look at (${n}/2), then press <b>Look</b>`
          : `Now select any 2 cards to swap (${n}/2) and press <b>Swap cards</b>, or press <b>Don't swap</b>`;
      }
      return `<div class="msg">${msg}.</div>`;
    }
    return '';
  }

  // Turn timer, counted locally between server updates.
  function peekLeft() {
    return Math.max(0, (S.peekDeadline || 0) - Date.now());
  }
  function turnLeft() {
    if (S.turnFrozen !== null) return S.turnFrozen;
    return Math.max(0, (S.turnDeadline || 0) - Date.now());
  }
  function turnPct() {
    const total = (S.room && S.room.game && S.room.game.turnMs) || 1;
    return Math.max(0, Math.min(100, (turnLeft() / total) * 100));
  }

  function closingLeft() {
    return Math.max(0, (S.closingDeadline || 0) - Date.now());
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
    const mo = room.matchOver;
    const moNames = mo ? room.players.filter((p) => mo.winners.includes(p.id)).map((p) => esc(p.name)) : [];
    const matchHtml = mo
      ? `<div class="match-over">🏆 ${mo.winners.includes(room.you) ? 'You win the match!' : `${moNames.join(' & ')} win${moNames.length === 1 ? 's' : ''} the match!`}
          <small>Someone reached ${room.targetScore} points, so the lowest total wins.</small></div>`
      : room.targetScore ? `<p class="muted" style="margin:0">Playing to ${room.targetScore} points. Totals are on the right.</p>` : '';
    return `
      <div class="results">
        ${matchHtml}
        <h2>${winners.includes(room.you) ? 'You win!' : `${names.join(' & ')} win${names.length === 1 ? 's' : ''}!`}</h2>
        ${g.results.tieBreak === 'cambio' ? '<p class="muted" style="margin:0">Tie! The Cambrio caller wins ties.</p>' : ''}
        ${g.results.tieBreak === 'lowestCard' ? '<p class="muted" style="margin:0">Tie! Broken by the lowest single card.</p>' : ''}
        <table>${rows}</table>
        <div class="actions" style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
          ${isHost ? `<button class="primary" data-do="again" ${online < 2 ? 'disabled' : ''}>${mo ? 'Start a new match' : room.targetScore ? 'Next round' : 'Play again'}</button>` : '<span class="muted">Waiting for the host to start the next round…</span>'}
          ${g.replay && g.replay.length ? '<button class="secondary" data-do="replay">▶ Watch replay</button>' : ''}
          <button class="ghost small" data-do="leave">Leave room</button>
        </div>
      </div>`;
  }

  // Seats around the table, like a poker table. You sit at the bottom; play goes
  // clockwise, so the next player sits on your left, then across the top, then the right.
  const RING_SPLIT = { 0: [0, 0, 0], 1: [0, 1, 0], 2: [1, 0, 1], 3: [1, 1, 1], 4: [1, 2, 1], 5: [2, 1, 2], 6: [2, 2, 2], 7: [2, 3, 2] };
  function seatRing(opponents) {
    const [l, t] = RING_SPLIT[Math.min(opponents.length, 7)];
    const left = opponents.slice(0, l);
    const top = opponents.slice(l, l + t);
    const right = opponents.slice(l + t);
    const cls = [`seats-${opponents.length}`, top.length ? '' : 'no-top', left.length ? '' : 'no-sides'].join(' ');
    // On wide screens every seat sits at an even angle round the oval (you at the bottom).
    const total = opponents.length + 1;
    const spot = (p) => {
      const k = opponents.indexOf(p) + 1;
      const a = ((90 + (k * 360) / total) * Math.PI) / 180;
      return `--x:${(50 + 42 * Math.cos(a)).toFixed(2)}%;--y:${(50 + 40 * Math.sin(a)).toFixed(2)}%`;
    };
    return { left, top, right, cls, spot };
  }

  function renderGame(room) {
    const g = room.game;
    const me = room.you;
    // Drop selections that no longer point at a card.
    S.selected = S.selected.filter((t) => cardAtView(g, t));
    if (g.phase !== 'play') { S.selected = []; S.noteMode = false; S.noteSel = []; }
    S.noteSel = S.noteSel.filter((t) => cardAtView(g, t));
    if (!needsTwo(g, me) && !opt(g, 'notes') && S.selected.length > 1) S.selected = S.selected.slice(-1);
    if (g.turnMsLeft !== null && g.turnMsLeft !== undefined) {
      S.turnFrozen = g.paused ? g.turnMsLeft : null;
      const deadline = Date.now() + g.turnMsLeft;
      if (!S.turnDeadline || Math.abs(S.turnDeadline - deadline) > 400 || S.turnKey !== `${g.current}:${g.stage}`) S.turnDeadline = deadline;
      S.turnKey = `${g.current}:${g.stage}`;
    } else {
      S.turnDeadline = null;
      S.turnFrozen = null;
    }
    if (g.closingMsLeft !== null && g.closingMsLeft !== undefined) {
      const deadline = Date.now() + g.closingMsLeft;
      if (!S.closingDeadline || Math.abs(S.closingDeadline - deadline) > 400) S.closingDeadline = deadline;
    } else {
      S.closingDeadline = null;
    }
    if (g.peekMsLeft !== null && g.peekMsLeft !== undefined) {
      const deadline = Date.now() + g.peekMsLeft;
      if (!S.peekDeadline || Math.abs(S.peekDeadline - deadline) > 400) S.peekDeadline = deadline;
    } else {
      S.peekDeadline = null;
    }

    const myIdx = g.players.findIndex((p) => p.id === me);
    const ordered = myIdx === -1 ? g.players : g.players.slice(myIdx + 1).concat(g.players.slice(0, myIdx));
    const opponents = ordered.filter((p) => p.id !== me);
    const ring = seatRing(opponents);
    const mine = g.players[myIdx];

    const myTurn = g.current === me;
    const canDraw = actionState(g, me).draw;
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

    const totals = room.players.length && (room.round > 1 || (room.targetScore && g.phase === 'ended'))
      ? `<div class="scores"><h3>Room totals${room.targetScore ? ` · to ${room.targetScore}` : ''}</h3><table>${[...room.players].sort((a, b) => a.totalScore - b.totalScore).map((p) => `<tr><td>${esc(p.name)}</td><td>${p.wins}🏆 · ${p.totalScore} pts</td></tr>`).join('')}</table></div>` : '';
    const showPanel = g.phase === 'play' && myIdx !== -1;

    app.innerHTML = `
      <section class="table ${showPanel ? 'playing' : ''}">
        <div class="play-area">
          <div class="ring ${ring.cls}">
          <div class="opponents ring-left">${ring.left.map((p) => `<div class="spot" style="${ring.spot(p)}">${seatHtml(g, p, me, false)}</div>`).join('')}</div>
          <div class="opponents ring-top">${ring.top.map((p) => `<div class="spot" style="${ring.spot(p)}">${seatHtml(g, p, me, false)}</div>`).join('')}</div>
          <div class="opponents ring-right">${ring.right.map((p) => `<div class="spot" style="${ring.spot(p)}">${seatHtml(g, p, me, false)}</div>`).join('')}</div>
          <div class="mid">
          <div class="center-row">
            <div class="pile">${g.deckCount ? cardHtml({ hidden: true }, { clickable: canDraw, key: 'deck', data: { do: 'draw' } }) : cardHtml(null, { key: 'deck' })}<span>Deck · ${g.deckCount}</span></div>
            ${drawnHtml}
            ${showPanel ? panelHtml(g, me) : ''}
            <div class="pile">${discardHtml(g, popDiscard)}<span>Discard · ${g.discardCount}</span></div>
          </div>
          ${resultsHtml(g, room)}
          ${g.phase !== 'ended' ? `<div class="prompt">${promptHtml(g, me)}</div>` : ''}
          ${noteBarHtml(g)}
          </div>
          <div class="mine">${mine ? seatHtml(g, mine, me, true) : '<p class="center muted">You are watching this game. You can play from the next round.</p>'}</div>
          </div>
        </div>
        <aside class="side">
          <div class="log" id="log"><h3>What happened</h3>${g.log.map((l) => `<p>${esc(l.text)}</p>`).join('')}</div>
          ${cardsLeftHtml(g)}
          ${totals}
          ${g.phase !== 'ended' ? `<button class="ghost small" data-do="leave">${confirming('leave') ? 'Tap again to leave' : 'Leave room'}</button>` : ''}
        </aside>
        ${myIdx !== -1 ? `<div class="react-box ${S.reactOpen ? 'open' : ''}">
          ${S.reactOpen ? `<div class="react-pick">${REACTIONS.map((e) => `<button data-do="emoji" data-emoji="${e}" aria-label="Send ${e}">${e}</button>`).join('')}</div>` : ''}
          <button class="react-btn" data-do="react" aria-label="Send a reaction" aria-expanded="${!!S.reactOpen}">😀</button>
        </div>` : ''}
      </section>`;
    const log = document.getElementById('log');
    log.scrollTop = log.scrollHeight;
    if (g.phase === 'ended') S.endShownRound = room.round;
  }

  // Card notes: select cards (tap, or drag across several), press Note, pick the info, Apply.
  // With one card picked you edit that card's note; with several, the info is added to each.
  // It floats over the middle of the table so nothing else moves.
  function noteBarHtml(g) {
    if (!S.noteMode || !opt(g, 'notes') || g.phase !== 'play') return '';
    const info = S.noteInfo;
    const left = g.unplayed || {};
    // A rank whose cards are all discarded can't be any card in play, so it isn't offered.
    const chips = NOTE_RANKS.filter((r) => (left[r] || 0) > 0 || info.is.includes(r) || info.not.includes(r)).map((r) => {
      const st = info.is.includes(r) ? 'is' : info.not.includes(r) ? 'not' : '';
      return `<button class="chip ${st}" data-do="noterank" data-rank="${r}" aria-pressed="${!!st}">${rankShort(r)}</button>`;
    }).join('');
    const people = g.players.map((p) => {
      const on = info.knows.includes(p.id);
      return `<button class="chip who ${on ? 'on' : ''}" data-do="noteknows" data-id="${esc(p.id)}" aria-pressed="${on}">${esc(p.id === S.room.you ? 'You' : p.name)}</button>`;
    }).join('');
    const n = S.noteSel.length;
    const one = n === 1 ? S.noteSel[0] : null;
    const title = one
      ? `Note on ${one.pid === S.room.you ? 'your' : `${nameIn(g, one.pid)}'s`} card #${one.slot + 1}`
      : n ? `Add to the notes on ${n} cards` : 'Tap the cards this note is for';
    const hasInfo = info.is.length || info.not.length || info.knows.length;
    return `<div class="note-maker" role="dialog" aria-label="Card note">
      <b class="note-title">${title}</b>
      <span class="muted">Tap a rank once for <b class="not">isn't</b>, twice for <b class="is">is</b>.</span>
      <div class="chips">${chips}</div>
      <span class="muted">Who knows it:</span>
      <div class="chips">${people}</div>
      <div class="chips">
        <button class="primary small" data-do="noteapply" ${n && (hasInfo || one) ? '' : 'disabled'}>Apply</button>
        <button class="secondary small" data-do="noteclear" ${n ? '' : 'disabled'}>Clear note${n === 1 ? '' : 's'}</button>
        <button class="ghost small" data-do="notedone">Cancel</button>
      </div>
    </div>`;
  }

  function openNote(g, cards) {
    S.noteMode = true;
    S.noteSel = cards;
    S.selected = [];
    const one = cards.length === 1 && cardAtView(g, cards[0]);
    const n = one && one.note;
    S.noteInfo = n ? { is: [...n.is], not: [...n.not], knows: [...(n.knows || [])] } : { is: [], not: [], knows: [] };
    render();
  }

  function closeNotes() {
    S.noteMode = false; S.noteSel = []; S.noteInfo = { is: [], not: [], knows: [] };
  }

  // Hard mode: how many of each card have not been discarded yet.
  const LEFT_ORDER = [['K-red', `K ${SUIT.H}${SUIT.D}`, 2], ['JOKER', 'Joker', 2], ['A', 'A', 4], ['2', '2', 4], ['3', '3', 4], ['4', '4', 4], ['5', '5', 4], ['6', '6', 4],
    ['7', '7', 4], ['8', '8', 4], ['9', '9', 4], ['10', '10', 4], ['J', 'J', 4], ['Q', 'Q', 4], ['K-black', `K ${SUIT.S}${SUIT.C}`, 2]];
  function cardsLeftHtml(g) {
    if (!opt(g, 'counter') || !g.unplayed) return '';
    const open = !!S.showLeft;
    const rows = LEFT_ORDER.map(([k, label, total]) => {
      const n = g.unplayed[k] || 0;
      return `<div class="left-cell ${n ? '' : 'gone'}"><b>${label}</b><span>${n}/${total}</span></div>`;
    }).join('');
    return `<div class="cards-left">
      <button class="secondary small" data-do="cardsleft" aria-expanded="${open}">${open ? 'Hide cards left' : 'Cards left'}</button>
      ${open ? `<p class="muted small-note">Cards not discarded yet (still in the deck or in someone's hand).</p><div class="left-grid">${rows}</div>` : ''}
    </div>`;
  }

  function discardHtml(g, popDiscard) {
    // While a card is flying to the pile, show the card underneath it.
    if (S.inFlight.has('discard')) {
      return `<div class="discard-stack">${g.discardUnder ? cardHtml(g.discardUnder) : cardHtml(null)}${cardHtml(g.discardTop, { key: 'discard' }).replace('class="card', 'class="card stack-top')}</div>`;
    }
    return g.discardTop ? cardHtml(g.discardTop, { pop: popDiscard, key: 'discard' }) : cardHtml(null, { key: 'discard' });
  }

  // Update the end-of-round countdown without re-rendering the table.
  setInterval(() => {
    const el = app.querySelector('.countdown');
    if (el) el.textContent = String(Math.ceil(closingLeft() / 1000));
    const peekEl = app.querySelector('.peek-countdown');
    if (peekEl) peekEl.textContent = String(Math.ceil(peekLeft() / 1000));
    const secs = app.querySelector('.turn-secs');
    if (secs) {
      const left = turnLeft();
      secs.textContent = `${Math.ceil(left / 1000)}s`;
      secs.classList.toggle('low', left <= 3000);
      const fill = app.querySelector('.turn-fill');
      if (fill) { fill.style.width = `${turnPct()}%`; fill.classList.toggle('low', left <= 3000); }
    }
  }, 200);

  // ---------- clicks ----------
  function askToConfirm(kind) {
    S.confirm = { kind, until: Date.now() + 4000 };
    render();
    setTimeout(() => { if (S.confirm && S.confirm.until <= Date.now()) { S.confirm = null; render(); } }, 4100);
  }

  function useSelection(n) {
    const targets = S.selected.slice(0, n);
    S.selected = [];
    return targets;
  }

  app.addEventListener('click', (e) => {
    const el = e.target.closest('[data-do], [data-pid]');
    if (!el || !S.room) return;
    if (S.suppressClick && S.suppressClick > Date.now() && el.dataset.pid !== undefined) { S.suppressClick = 0; return; }
    const g = S.room.game;
    const d = el.dataset.do;
    if (el.disabled) return;
    if (d === 'ready') return act('ready');
    if (d === 'again') return call('start_game', {});
    if (d === 'replay') return g && g.replay && openReplay(g.replay, g.players);
    if (d === 'react') { S.reactOpen = !S.reactOpen; return render(); }
    if (d === 'emoji') { S.reactOpen = false; render(); return call('react', { emoji: el.dataset.emoji }); }
    if (d === 'leave') {
      if (S.room.game && S.room.game.phase !== 'ended' && !confirming('leave')) return askToConfirm('leave');
      S.confirm = null;
      return leaveRoom();
    }
    if (!g) return;
    if (d === 'draw') { if (actionState(g, S.room.you).draw) act('draw_deck'); return; }
    if (d === 'discard') return act('discard');
    if (d === 'swap') { const [t] = useSelection(1); act('swap', { slot: t.slot }); return render(); }
    if (d === 'give') { const [t] = useSelection(1); act('give', { slot: t.slot }); return render(); }
    if (d === 'stick') { const [t] = useSelection(1); act('stick', { target: t }); return render(); }
    if (d === 'power') {
      const need = g.power && (g.power.type === 'peekOwn' || g.power.type === 'peekOther') ? 1 : 2;
      act('power_pick', { targets: useSelection(need) });
      return render();
    }
    if (d === 'skip') { S.selected = []; return act('skip_power'); }
    if (d === 'done') return act('done_sticking');
    if (d === 'cardsleft') { S.showLeft = !S.showLeft; return render(); }
    if (d === 'note') {
      if (S.noteMode) { closeNotes(); return render(); }
      return openNote(g, S.selected.slice());
    }
    if (d === 'notedone') { closeNotes(); return render(); }
    if (d === 'noterank') {
      const info = S.noteInfo; const r = el.dataset.rank;
      // One tap: it isn't this. Two taps: it is this. Three: neither.
      if (info.not.includes(r)) { info.not = info.not.filter((x) => x !== r); info.is.push(r); }
      else if (info.is.includes(r)) info.is = info.is.filter((x) => x !== r);
      else info.not.push(r);
      return render();
    }
    if (d === 'noteknows') {
      const info = S.noteInfo; const id = el.dataset.id;
      info.knows = info.knows.includes(id) ? info.knows.filter((x) => x !== id) : [...info.knows, id];
      return render();
    }
    if (d === 'noteapply' || d === 'noteclear') {
      const targets = S.noteSel.slice();
      const msg = d === 'noteclear' ? { targets, clear: true }
        : { targets, add: S.noteInfo, replace: targets.length === 1 };
      closeNotes();
      act('note', msg);
      return render();
    }
    if (d === 'cambio') {
      if (!confirming('cambio')) return askToConfirm('cambio');
      S.confirm = null;
      act('call_cambio');
      return render();
    }

    // Tapping a card selects or unselects it. Only one card at a time, except
    // for the J, Q and black K powers, which need two.
    if (el.dataset.pid !== undefined && el.classList.contains('clickable')) {
      const t = { pid: el.dataset.pid, slot: Number(el.dataset.slot) };
      if (S.noteMode) { // picking cards for a note: any number
        const j = S.noteSel.findIndex((x) => x.pid === t.pid && x.slot === t.slot);
        if (j >= 0) S.noteSel.splice(j, 1); else S.noteSel.push(t);
        return render();
      }
      const i = S.selected.findIndex((x) => x.pid === t.pid && x.slot === t.slot);
      if (i >= 0) S.selected.splice(i, 1);
      else {
        S.selected.push(t);
        const max = needsTwo(g, S.room.you) ? 2 : 1;
        while (S.selected.length > max) S.selected.shift();
      }
      render();
    }
  });
  // Hold and drag across cards to select several at once (for notes, or the
  // two cards of a J, Q or black K power). A plain tap still selects one card.
  let drag = null;
  const cardKeyOf = (el) => el && el.closest && el.closest('.card.clickable[data-pid]');
  app.addEventListener('pointerdown', (e) => {
    const el = cardKeyOf(e.target);
    if (!el || !S.room || !S.room.game || (e.pointerType === 'mouse' && e.button !== 0)) return;
    drag = { start: el.dataset.key, keys: [el.dataset.key], moved: false };
    // Long-press a card (about half a second) to open its note straight away.
    const g = S.room.game;
    if (opt(g, 'notes') && g.phase === 'play' && !S.noteMode) {
      const d = drag;
      d.press = setTimeout(() => {
        if (drag !== d || d.moved) return;
        drag = null;
        S.suppressClick = Date.now() + 600;
        const [, pid, slot] = d.start.split(':');
        openNote(S.room.game, [{ pid, slot: Number(slot) }]);
        if (navigator.vibrate) try { navigator.vibrate(15); } catch { /* not supported */ }
      }, 500);
    }
  });
  app.addEventListener('contextmenu', (e) => { if (cardKeyOf(e.target)) e.preventDefault(); });
  app.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const el = cardKeyOf(document.elementFromPoint(e.clientX, e.clientY));
    if (!el || drag.keys.includes(el.dataset.key)) return;
    drag.moved = true;
    clearTimeout(drag.press);
    drag.keys.push(el.dataset.key);
    for (const k of drag.keys) { const c = app.querySelector(`[data-key="${k}"]`); if (c) c.classList.add(S.noteMode ? 'note-pick' : 'selected'); }
  });
  const endDrag = () => {
    const d = drag; drag = null;
    if (d) clearTimeout(d.press);
    if (!d || !d.moved || !S.room || !S.room.game) return;
    const g = S.room.game;
    const picked = d.keys.map((k) => { const [, pid, slot] = k.split(':'); return { pid, slot: Number(slot) }; })
      .filter((t) => cardAtView(g, t));
    if (S.noteMode) {
      for (const t of picked) if (!S.noteSel.some((x) => x.pid === t.pid && x.slot === t.slot)) S.noteSel.push(t);
    } else {
      const max = opt(g, 'notes') ? Infinity : needsTwo(g, S.room.you) ? 2 : 1;
      S.selected = picked.slice(-max);
    }
    S.suppressClick = Date.now() + 400; // the click that ends a drag shouldn't toggle a card
    render();
  };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', () => { if (drag) clearTimeout(drag.press); drag = null; });

  app.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.card.clickable')) { e.preventDefault(); e.target.click(); }
  });

  // ---------- render ----------
  function render() {
    if (!S.room) return;
    const badge = document.getElementById('roomBadge');
    badge.hidden = false;
    badge.innerHTML = `Room <b>${esc(S.room.code)}</b>`;
    document.body.classList.toggle('ingame', !!S.room.game); // dim the room around the table
    if (!S.room.game) renderLobby(S.room);
    else renderGame(S.room);
  }

  document.getElementById('rulesBtn').onclick = () => document.getElementById('rulesDialog').showModal();

  // ---------- look: card backs and table colours (saved on this device) ----------
  const CARD_BACKS = [['red', 'Classic red'], ['navy', 'Midnight'], ['gold', 'Black & gold'], ['teal', 'Ocean']];
  const TABLES = [['green', 'Green felt'], ['blue', 'Blue'], ['purple', 'Purple'], ['charcoal', 'Charcoal']];
  const look = {
    back: CARD_BACKS.some(([k]) => k === store.get('cambrioBack')) ? store.get('cambrioBack') : 'red',
    table: TABLES.some(([k]) => k === store.get('cambrioTable')) ? store.get('cambrioTable') : 'green',
  };
  function applyLook() {
    document.body.dataset.back = look.back;
    document.body.dataset.table = look.table;
  }
  function setLook(k, v) { look[k] = v; store.set(k === 'back' ? 'cambrioBack' : 'cambrioTable', v); applyLook(); }
  applyLook();

  // ---------- tutorial ----------
  const TUTORIAL = [
    ['Welcome to Cambrio', `<p>The goal: have the <b>lowest total</b> when the round ends.</p>
      <div class="tut-cards"></div>
      <p>Red King −1, Joker 0, Ace 1, 2–10 face value, Jack 11, Queen 12, Black King 13.</p>`],
    ['Peek, then remember', `<p>You get 4 face-down cards (or 6). At the start you see your <b>bottom row</b> for 10 seconds. Then they flip face down, so remember them!</p>`],
    ['Your turn', `<p>Press <b>Draw</b>. Then either select one of your cards and press <b>Swap</b> to keep the new card, or press <b>Discard</b> to throw it away.</p>
      <div class="tut-buttons"><span>Draw</span><span>Swap</span><span>Discard</span></div>`],
    ['Powers', `<p>Discard a card you just drew to use its power:</p>
      <ul><li><b>7, 8:</b> look at one of your cards</li><li><b>9, 10:</b> look at someone else's card</li><li><b>J, Q:</b> swap any two cards blind</li><li><b>Black King:</b> look at two cards, then you may swap two</li></ul>`],
    ['Sticking', `<p>See a card that matches the top of the discard pile? Select it and press <b>Stick</b>, any time, even on someone else's turn.</p>
      <p>Right on your own card: it's gone. Right on someone else's: you give them one of yours. Wrong: it goes back and you take a penalty card.</p>`],
    ['Calling Cambrio', `<p>Think you're lowest? Press <b>Call Cambrio</b> instead of drawing. Everyone else gets one last turn, then there's a last chance to stick, and all cards are shown.</p>
      <p>The caller wins ties.</p>`],
    ["You're ready!", `<p>Selecting: tap a card, or hold and drag across several. The full rules are always under <b>Rules</b> at the top.</p>
      <p>Private rooms can add bots and turn on extra help like card notes. Every game has emoji reactions, stick times and a round replay.</p>`],
  ];
  // ---------- achievements ----------
  // Earned in games (the server decides), kept on this device like the card back.
  const ACHIEVEMENTS = [
    ['firstwin', '🥇', 'First win', 'Win your first game.'],
    ['odds', '🎲', 'Against the odds', 'Win with a score above 25.'],
    ['loneking', '♚', 'Lone king', 'Win with only 1 card left, and it is a black king.'],
    ['belowzero', '🥶', 'Below zero', 'Win with exactly −2.'],
    ['perfect', '💎', 'Perfect hand', 'Win with 4 cards: 2 jokers and 2 red kings.'],
    ['bighand', '🖐️', 'Full house', 'Win with 5 or more cards.'],
    ['empty', '🫥', 'Empty handed', 'Lose all your cards.'],
    ['quickdraw', '⚡', 'Quick draw', 'A correct stick in under 1 second.'],
    ['sticky', '🍯', 'Sticky fingers', '3 correct sticks in one round.'],
    ['pickpocket', '🧤', 'Pickpocket', "Stick someone else's card."],
    ['butterfingers', '🧈', 'Butterfingers', 'Make a wrong stick.'],
    ['boldcall', '📣', 'Bold call', 'Call Cambrio and win.'],
    ['calledout', '🙈', 'Called out', 'Call Cambrio and lose.'],
    ['comeback', '🔄', 'Comeback call', 'Call Cambrio while losing, and end up winning.'],
    ['lightning', '🌩️', 'Lightning', 'Call Cambrio on your first turn and win.'],
    ['tiebreak', '🤝', 'Tie breaker', 'Win a tie because you called Cambrio.'],
    ['zero', '0️⃣', 'Zero hero', 'Finish a round with exactly 0.'],
    ['hoarder', '🐿️', 'Hoarder', 'Finish a round holding 10 or more cards.'],
    ['double', '👑', 'Double trouble', 'Finish holding both black kings.'],
    ['hattrick', '🎩', 'Hat trick', 'Win 3 rounds in a row in one room.'],
    ['champion', '🏆', 'Champion', 'Win a match to 50 points.'],
    ['ultimate', '🌟', 'Ultimate champion', 'Win a match to 100 points.'],
    ['botbeater', '🤖', 'Bot beater', 'Win a round against 7 bots.'],
  ];
  const ACH_BY_ID = Object.fromEntries(ACHIEVEMENTS.map((a) => [a[0], a]));
  function unlocked() {
    try { return JSON.parse(store.get('cambrioAchievements') || '{}') || {}; } catch { return {}; }
  }
  /** Saves any newly earned achievements and pops each one up. */
  function noteEarned(ids) {
    const have = unlocked();
    const fresh = (ids || []).filter((id) => ACH_BY_ID[id] && !have[id]);
    if (!fresh.length) return;
    for (const id of fresh) have[id] = Date.now();
    store.set('cambrioAchievements', JSON.stringify(have));
    S.achQueue = (S.achQueue || []).concat(fresh);
    if (!S.achShowing) showNextAchievement();
  }
  function showNextAchievement() {
    const id = (S.achQueue || []).shift();
    if (!id) { S.achShowing = false; return; }
    S.achShowing = true;
    const [, icon, name, desc] = ACH_BY_ID[id];
    const el = document.createElement('div');
    el.className = 'ach-pop';
    el.setAttribute('role', 'status');
    el.innerHTML = `<span class="ach-icon">${icon}</span><span><small>Achievement unlocked</small><b>${esc(name)}</b><em>${esc(desc)}</em></span>`;
    document.body.appendChild(el);
    const done = () => { el.remove(); showNextAchievement(); };
    if (REDUCED_MOTION) { setTimeout(done, 3200); return; }
    el.animate([{ transform: 'translate(-50%,-140%)', opacity: 0 }, { transform: 'translate(-50%,0)', opacity: 1, offset: 0.12 },
      { transform: 'translate(-50%,0)', opacity: 1, offset: 0.88 }, { transform: 'translate(-50%,-140%)', opacity: 0 }],
    { duration: 3400, easing: 'ease-out', fill: 'forwards' }).finished.then(done);
  }
  function openAchievements() {
    let dlg = document.getElementById('achDialog');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'achDialog';
      document.body.appendChild(dlg);
      dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target.closest('[data-a=close]')) dlg.close(); });
    }
    const have = unlocked();
    const count = ACHIEVEMENTS.filter(([id]) => have[id]).length;
    dlg.innerHTML = `<div class="rules ach-list">
      <h2>Achievements <small class="muted">${count} of ${ACHIEVEMENTS.length}</small></h2>
      <p class="muted">Saved on this device. Earn them in any game, quick play or private.</p>
      <ul>${ACHIEVEMENTS.map(([id, icon, name, desc]) => `<li class="${have[id] ? 'got' : 'locked'}"><span class="ach-icon">${have[id] ? icon : '🔒'}</span><span><b>${esc(name)}</b><small>${esc(desc)}</small></span></li>`).join('')}</ul>
      <div class="tut-nav"><button class="primary small" data-a="close">Close</button></div>
    </div>`;
    dlg.showModal();
  }

  function openTutorial(i = 0) {
    let dlg = document.getElementById('tutorialDialog');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'tutorialDialog';
      dlg.className = 'tutorial';
      document.body.appendChild(dlg);
    }
    const [title, body] = TUTORIAL[i];
    const demo = ['K', 'JOKER', '7', 'Q'].map((r, j) => cardHtml(r === 'JOKER' ? { rank: r } : { rank: r, suit: ['H', 'S', 'D', 'C'][j] })).join('');
    dlg.innerHTML = `<div class="rules">
      <div class="tut-step">Step ${i + 1} of ${TUTORIAL.length}</div>
      <h2>${title}</h2>
      ${body.replace('<div class="tut-cards"></div>', `<div class="tut-cards">${demo}</div>`)}
      <div class="tut-nav">
        <button class="ghost small" data-t="close">Close</button>
        ${i > 0 ? '<button class="secondary small" data-t="back">Back</button>' : ''}
        ${i < TUTORIAL.length - 1 ? '<button class="primary small" data-t="next">Next</button>' : '<button class="primary small" data-t="close">Let\'s play</button>'}
      </div></div>`;
    dlg.querySelectorAll('[data-t]').forEach((b) => {
      b.onclick = () => {
        if (b.dataset.t === 'close') return dlg.close();
        openTutorial(i + (b.dataset.t === 'next' ? 1 : -1));
      };
    });
    if (!dlg.open) dlg.showModal();
  }

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
