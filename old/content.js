(() => {
  if (window.__mhContentInjected) return;
  window.__mhContentInjected = true;

  window.addEventListener('mh-real-click', (ev) => {
    try {
      const { x, y, dbl } = JSON.parse(ev.detail);
      chrome.runtime.sendMessage({ target: 'bg', type: 'realClick', x, y, dbl }).catch(() => { });
    } catch (_) { }
  });

  const ALERT_COOLDOWN_MS = 60_000;  // mínimo entre alertas del mismo jugador
  const tracked = new Map();         // nombre -> { x, y, firstSeen, lastSeen, lastAlert, notified, src }
  const cfg = { watch: [], minDist: 0, ttl: 15, meX: 226, meY: 236, resetLv: 400, resetBase: 0 };
  const AUTO_MOVE = { lv: 170, cmd: '/move icarus', map: 10, x: 46, y: 199, maxTries: 3, cdMs: 45000 };
  let me = null;                     // posición propia detectada por el interceptor { x, y, ts }
  let lastData = 0;

  // Config viva desde storage (la edita la ventana del radar)
  const readCfg = () => chrome.storage.local
    .get(['watchlist', 'radarMinDist', 'radarTTL', 'radarMeX', 'radarMeY', 'resetLv', 'resetBase'])
    .then((c) => {
      cfg.watch = (c.watchlist || '').split(',').map((n) => n.trim().toLowerCase()).filter(Boolean);
      cfg.minDist = +c.radarMinDist || 0;
      cfg.ttl = Math.max(3, +c.radarTTL || 15);
      cfg.meX = +(c.radarMeX ?? 226);
      cfg.meY = +(c.radarMeY ?? 236);
      cfg.resetLv = +(c.resetLv ?? 400);
      cfg.resetBase = +(c.resetBase ?? 0);
    }).catch(() => { });
  readCfg();
  chrome.storage.onChanged.addListener((_, area) => { if (area === 'local') readCfg(); });

  // Posición propia: la detectada si es reciente, si no la manual
  const getMe = () => (me && Date.now() - me.ts < 5000)
    ? { x: me.x, y: me.y, auto: true }
    : { x: cfg.meX, y: cfg.meY, auto: false };

  window.addEventListener('mh-mypos', (ev) => {
    try {
      const d = JSON.parse(ev.detail);
      if (Number.isFinite(+d.x) && Number.isFinite(+d.y)) me = { x: +d.x, y: +d.y, map: d.map, ts: Date.now() }
    } catch (_) { }
  });

  window.addEventListener('mh-map', (ev) => {
    window.addEventListener('mh-rubber-forward', () => {
      if (walkTimer) stopWalk('servidor te movió', false);
    });

    try {
      const d = JSON.parse(ev.detail);
      tracked.clear();
      chrome.storage.local.set({ ['map:' + d.map]: d.b64 });
    } catch (_) { }
  });
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data?.__mh === 'rubber' && walkTimer) stopWalk('servidor te movió', false);
  });
  // Cada avistamiento actualiza el estado. Se alerta UNA vez por "visita": cuando el jugador
  // aparece (o reaparece tras estar > ttl sin verse) y cumple la distancia. Mientras siga
  // visible solo se actualiza su posición, así un dato viejo ya no re-alerta cada minuto.
  window.addEventListener('mh-entity', (ev) => {
    try {
      const { src, list } = JSON.parse(ev.detail);
      const now = Date.now();
      const ttlMs = cfg.ttl * 1000;
      const m = getMe();
      lastData = now;

      const seen = {};
      for (const e of list) {
        const k = seen[e.n] = (seen[e.n] ?? -1) + 1;
        const key = k ? `${e.n}#${k}` : e.n;
        let t = tracked.get(key);
        const wasPresent = !!t && now - t.lastSeen <= ttlMs;
        if (!t) { t = { lastAlert: 0 }; tracked.set(key, t); }
        if (!wasPresent) { t.firstSeen = now; t.notified = false; }
        t.name = e.n; t.x = e.x; t.y = e.y; t.lastSeen = now; t.src = src;

        if (t.notified || !cfg.watch.includes(e.n.toLowerCase())) continue;
        const dist = Math.round(Math.hypot(e.x - m.x, e.y - m.y));
        if (dist < cfg.minDist) continue;
        t.notified = true;
        if (now - t.lastAlert < ALERT_COOLDOWN_MS) continue;
        t.lastAlert = now;
        chrome.runtime.sendMessage({
          target: 'bg', type: 'alert_interest',
          nombre: e.n, distancia: dist, x: e.x, y: e.y
        }).catch(() => { });
      }

      if (tracked.size > 300) {
        for (const [k, v] of tracked) if (now - v.lastSeen > 300_000) tracked.delete(k);
      }
    } catch (_) { }
  });

  // ---- AUTOWALK: BFS sobre el terreno + clic hacia un waypoint adelantado ----
  const wcfg = { lookahead: 10, tick: 150, maxStill: 24 }; // maxStill = ticks sin moverse (~3.6 s)
  let walkTimer = null, followTimer = null, walkMsg = '', walkPath = null, walkIdx = 0;

  // halt=true: además hace clic en el centro (tu personaje) para que frene donde está
  const stopWalk = (why = 'detenido', halt = true) => {
    const was = !!walkTimer;
    clearInterval(walkTimer); walkTimer = null;
    walkPath = null;
    if (why !== 'llegó') { clearInterval(followTimer); followTimer = null; }
    walkMsg = why;
    if (was && halt && me) window.dispatchEvent(new CustomEvent('mh-moveto', { detail: JSON.stringify({ x: me.x, y: me.y }) }));
  };

  async function goTo(tx, ty, near = 3) {   // ⬅️ 3 tiles de tolerancia
    clearInterval(walkTimer); walkTimer = null;
    const fail = (m) => { walkMsg = m; console.warn('[MH]', m); };
    const mapId = me?.map;
    const b64 = (await chrome.storage.local.get('map:' + mapId))['map:' + mapId];
    if (!b64 || !me) return fail('sin terreno o sin pos');
    const bin = atob(b64);
    const ok = (x, y) => x >= 0 && y >= 0 && x < 256 && y < 256 && !(bin.charCodeAt(y * 256 + x) & 12); // bits 4 y 8 = bloqueado
    if (!ok(tx, ty)) return fail('destino no caminable');

    const s = getMe(), start = s.y * 256 + s.x, goal = ty * 256 + tx;
    const par = new Int32Array(65536).fill(-2);
    par[start] = -1;
    const q = [start];
    for (let h = 0; h < q.length && par[goal] === -2; h++) {
      const c = q[h], cx = c & 255, cy = c >> 8;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const nx = cx + dx, ny = cy + dy, n = ny * 256 + nx;
        if (!ok(nx, ny) || par[n] !== -2) continue;
        if (dx && dy && (!ok(cx + dx, cy) || !ok(cx, cy + dy))) continue;
        par[n] = c; q.push(n);
      }
    }
    if (par[goal] === -2) return fail('sin ruta');
    const path = [];
    for (let c = goal; c !== -1; c = par[c]) path.push({ x: c & 255, y: c >> 8 });
    path.reverse();
    console.log('[MH] ruta de', path.length, 'tiles');
    walkMsg = '';
    walkPath = path; walkIdx = 0;

    // línea recta libre entre dos tiles
    const los = (ax, ay, bx, by) => {
      const n = Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * 2;
      for (let i = 1; i <= n; i++) if (!ok(Math.round(ax + (bx - ax) * i / n), Math.round(ay + (by - ay) * i / n))) return false;
      return true;
    };

    let idx = 0, lastKey = '', still = 0, lastWp = null, lastSend = 0;
    walkTimer = setInterval(() => {
      const p = getMe(), now = Date.now();
      if (me?.map !== mapId) return stopWalk('cambió de mapa', false);
      if (!p.auto) return stopWalk('sin posición auto', true);
      if (Math.hypot(tx - p.x, ty - p.y) <= near) { stopWalk('llegó', false); return; }

      const lim = Math.min(path.length, idx + wcfg.lookahead * 2);
      let bd = 1e9;
      for (let j = idx; j < lim; j++) {
        const d = Math.hypot(path[j].x - p.x, path[j].y - p.y);
        if (d < bd && los(p.x, p.y, path[j].x, path[j].y)) { bd = d; idx = j; }
      }
      walkIdx = idx;

      const pk = p.x + ',' + p.y;
      still = pk === lastKey ? still + 1 : 0; lastKey = pk;
      if (still >= wcfg.maxStill) return stopWalk(`atascado en (${p.x}, ${p.y})`, true);

      let wp = path[Math.min(idx + 1, path.length - 1)];
      for (let j = Math.min(idx + wcfg.lookahead, path.length - 1); j > idx; j--) {
        if (los(p.x, p.y, path[j].x, path[j].y)) { wp = path[j]; break; }
      }

      const dLast = lastWp ? Math.hypot(lastWp.x - p.x, lastWp.y - p.y) : 99;
      if (now - lastSend > 200 && (!lastWp || (wp !== lastWp && dLast <= 3) || (still > 0 && still % 4 === 0))) {
        lastWp = wp; lastSend = now;
        window.dispatchEvent(new CustomEvent('mh-moveto', { detail: JSON.stringify({ x: wp.x, y: wp.y }) }));
      }
    }, wcfg.tick);
  }

  // ---- FOLLOW: recalcula la ruta hacia un jugador visible ----
  function follow(name) {
    clearInterval(followTimer);
    let dest = null, routing = false;
    followTimer = setInterval(() => {
      const now = Date.now(), p = getMe();
      let t = null;
      for (const v of tracked.values()) if (v.name === name && now - v.lastSeen <= cfg.ttl * 1000) t = v;
      if (!t) return stopWalk('perdió a ' + name, true);
      if (routing || Math.hypot(t.x - p.x, t.y - p.y) <= 3) return;
      if (walkTimer && dest && Math.hypot(t.x - dest.x, t.y - dest.y) < 4) return;
      dest = { x: t.x, y: t.y }; routing = true;
      goTo(t.x, t.y, 2.5).finally(() => { routing = false; });
    }, 2500);
  }

  // ---- AUTO-MOVE: tras el comando /move, espera el terreno del mapa nuevo y camina a (x, y) ----
  // Espera a estar EXACTAMENTE en destMap, con terreno cargado, y recién ahí hace autowalk a (destX, destY).
  // Al terminar libera el cerrojo de /move para que no quede bloqueado 30 s de más.
  function waitMapThenGo(destMap, destX, destY) {
    const t0 = Date.now();
    const wt = setInterval(async () => {
      const m = me, nowT = Date.now();
      if (nowT - t0 > 60000) {
        clearInterval(wt);
        AUTO.pendingMoveUntil = 0;
        console.warn('[MH-AUTO] waitMapThenGo: timeout esperando mapa', destMap);
        return;
      }
      if (!m || m.map == null) return;
      if (m.map !== destMap) return;

      const terr = (await chrome.storage.local.get('map:' + m.map))['map:' + m.map];
      if (!terr) return;

      clearInterval(wt);
      AUTO.pendingMoveUntil = 0;   // ⬅️ llegamos: liberar bloqueo de /move
      goTo(destX, destY).catch(() => { });
    }, 800);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.target !== 'content') return;
    if (msg.type === 'goto' && me) { clearInterval(followTimer); followTimer = null; goTo(msg.x, msg.y); }
    if (msg.type === 'follow' && me) follow(msg.name);
    if (msg.type === 'stopwalk') stopWalk();
  });

  // ---- OVERLAY: stats del personaje ----
  const ov = {
    el: null, name: null,
    exp0: 0, zen0: 0, t0: 0, samples: [],
    lastExp: null, lastLv: null,
    resetCount: 0, resetTimes: []
  };

  // Hidratar contadores de reset desde storage
  chrome.storage.local.get(['resetCount', 'resetTimes']).then((c) => {
    ov.resetCount = c.resetCount || 0;
    ov.resetTimes = Array.isArray(c.resetTimes) ? c.resetTimes : [];
  }).catch(() => { });

  window.addEventListener('keydown', (e) => {
    if (e.altKey && e.key.toLowerCase() === 'o' && ov.el) {
      ov.el.style.display = ov.el.style.display === 'none' ? '' : 'none';
    }
  }, true);

  window.addEventListener('mh-stats', (ev) => {
    try {
      const s = JSON.parse(ev.detail), now = Date.now();
      if (s.lv != null) AUTO.lv = s.lv;
      const curMap = me?.map;
      if (!ov.el) {
        ov.el = document.createElement('div');
        ov.el.style.cssText = 'position:fixed;top:8px;left:8px;z-index:2147483646;pointer-events:none;min-width:200px;padding:6px 8px;background:rgba(1,4,9,.82);border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font:11px/1.45 ui-monospace,Consolas,monospace;';
        document.documentElement.appendChild(ov.el);
      }
      if (ov.name !== s.n) Object.assign(ov, { name: s.n, exp0: s.exp, zen0: s.zen, t0: now, samples: [] });

      // Reset detectado por caída de EXP
      if (ov.lastExp != null && s.exp < ov.lastExp) {
        Object.assign(ov, { exp0: s.exp, zen0: s.zen, t0: now, samples: [] });
        chrome.runtime.sendMessage({ target: 'bg', type: 'stop' }).catch(() => { });
        AUTO.holding = false;
        AUTO.holdSpot = null;
      }
      ov.lastExp = s.exp;

      if (!ov.samples.length || now - ov.samples[ov.samples.length - 1].t >= 5000) {
        ov.samples.push({ t: now, exp: s.exp, zen: s.zen });
      }
      while (ov.samples[0] && now - ov.samples[0].t > 600000) ov.samples.shift();

      const f = ov.samples[0], dh = (now - f.t) / 3600000, ok = dh >= 0.0083;
      const expH = ok ? Math.max(0, (s.exp - f.exp) / dh) : 0;
      const eta = expH > 0 ? (s.next - s.exp) / expH : 0;
      const sh = (n) => Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2) + 'M'
        : Math.abs(n) >= 1e3 ? (n / 1e3).toFixed(1) + 'k'
          : String(Math.round(n));
      const row = (a, b, c) => `<div style="display:flex;justify-content:space-between;gap:12px"><span style="color:#8b949e">${a}</span><span style="color:${c || '#3fb950'}">${b}</span></div>`;
      const bar = (v, m, c) => `<div style="height:4px;background:#161b22;margin:1px 0 3px"><div style="height:100%;width:${Math.max(0, Math.min(100, m ? v / m * 100 : 0))}%;background:${c}"></div></div>`;
      const pct = s.next > s.cur ? (s.exp - s.cur) / (s.next - s.cur) * 100 : 0;
      const ses = (now - ov.t0) / 60000;
      const m = getMe();
      const nm = String(s.n).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

      const sendChat = (text) =>
        chrome.runtime.sendMessage({ target: 'bg', type: 'chat', text }).catch(() => { });

      const stopHoldThenChat = async (text) => {
        await chrome.runtime.sendMessage({ target: 'bg', type: 'stop' }).catch(() => { });
        await new Promise(r => setTimeout(r, 600));
        await sendChat(text);
      };

      // AUTO /reset
      if (!cfg.resetLv || s.lv < cfg.resetLv) ov.rst = { n: 0, t: 0 };
      else if (!s.lost) {
        ov.rst ??= { n: 0, t: 0 };
        if (ov.rst.n < 3 && now - ov.rst.t > 45000) {
          ov.rst.n++; ov.rst.t = now;
          if (walkTimer || followTimer) stopWalk('auto-reset', false);
          (async () => { await stopHoldThenChat('/reset'); })();
        }
      }

      // AUTO /MOVE
      // if (s.lv < AUTO_MOVE.lv || s.lost) {
      //   ov.mv = { n: 0, t: 0, done: false, going: false, map: curMap };
      // } else {
      //   ov.mv ??= { n: 0, t: 0, done: false, going: false, map: curMap };
      //   if (!ov.mv.done && !ov.mv.going && ov.mv.n < AUTO_MOVE.maxTries && now - ov.mv.t > AUTO_MOVE.cdMs) {
      //     ov.mv.n++; ov.mv.t = now; ov.mv.going = true;
      //     if (walkTimer || followTimer) stopWalk('auto-move', false);
      //     (async () => {
      //       await stopHoldThenChat(AUTO_MOVE.cmd);
      //       waitMapThenGo();
      //     })();
      //   }
      // }

      // ---- RESET REAL: lv cayó desde >= resetLv hasta <= 12 ----
      if (ov.lastLv != null && ov.lastLv >= (cfg.resetLv || 400) && s.lv <= 12 && !s.lost) {
        ov.resetTimes = (ov.resetTimes || []).filter(t => now - t < 24 * 3600 * 1000);
        ov.resetTimes.push(now);
        ov.resetCount = (ov.resetCount || 0) + 1;
        chrome.storage.local.set({ resetCount: ov.resetCount, resetTimes: ov.resetTimes });
        console.log('[MH] reset confirmado · total acumulado:', ov.resetCount);
      }
      ov.lastLv = s.lv;

      // ---- TIEMPO ESTIMADO AL PRÓXIMO RESET ----
      const base = (L) =>
        (L + 8) * (L - 1) ** 2 +
        (L > 255 ? 100 * (L - 247) * (L - 256) ** 2 : 0);

      const tgt = cfg.resetLv || 400;
      const nextBase = base(s.lv + 1);
      const mul = nextBase > 0 ? s.next / nextBase : 0;
      const resetExp = base(tgt) * mul;
      const resetLeft = Math.max(0, resetExp - s.exp);
      const resetHours = expH > 0 ? resetLeft / expH : Infinity;

      const fmtTime = (hours) => {
        if (!Number.isFinite(hours)) return ok ? 'sin EXP' : 'midiendo…';
        if (hours <= 0) return 'AHORA';
        const totalMin = Math.max(1, Math.round(hours * 60));
        const h = Math.floor(totalMin / 60);
        const min = totalMin % 60;
        if (h >= 99) return '99h+';
        if (h > 0) return `${h}h ${min}m`;
        return `${min} min`;
      };

      const fmtClock = (date) => {
        let h = date.getHours();
        const min = String(date.getMinutes()).padStart(2, '0');
        const suffix = h >= 12 ? 'pm' : 'am';
        h %= 12; if (h === 0) h = 12;
        return `${h}:${min} ${suffix}`;
      };

      const resetDate = Number.isFinite(resetHours)
        ? new Date(now + resetHours * 3600000)
        : null;

      const rEta =
        s.lv >= tgt ? 'AHORA'
          : !ok ? 'midiendo…'
            : expH <= 0 ? 'sin EXP'
              : `${fmtTime(resetHours)} (${fmtClock(resetDate)})`;

      const totalResets = (cfg.resetBase || 0) + (ov.resetCount || 0);
      const rLastHour = (ov.resetTimes || []).filter(t => now - t < 3600 * 1000).length;
      const rLastDay = (ov.resetTimes || []).filter(t => now - t < 24 * 3600 * 1000).length;

      ov.el.innerHTML =
        (s.lost ? '<div style="color:#fff;background:#da3633;text-align:center;font-weight:700;margin-bottom:3px">DESCONECTADO</div>' : '') +
        `<div style="color:#f0b429;font-weight:700">${nm} · Lv ${s.lv}${s.ml ? ' +' + s.ml : ''}</div>` +
        (s.res != null ? row('Resets (juego)', s.res, '#58a6ff') : '') +
        (s.gres != null ? row('Grand resets', s.gres, '#58a6ff') : '') +
        row('Resets (tú)', totalResets, '#f0b429') +
        row('Resets/h (1h)', rLastHour, '#f0b429') +
        row('Resets/día (24h)', rLastDay, '#f0b429') +
        row('EXP', pct.toFixed(1) + '%') + bar(s.exp - s.cur, s.next - s.cur, '#58a6ff') +
        row('EXP/h (10m)', ok ? sh(expH) : '…') +
        row('Próx. nivel', eta > 0 && eta < 100 ? Math.floor(eta) + 'h ' + Math.round(eta % 1 * 60) + 'm' : '—') +
        row('Tiempo p/ reset', rEta, '#f0b429') +
        row('Sesión', Math.floor(ses / 60) + 'h ' + Math.round(ses % 60) + 'm · +' + sh(s.exp - ov.exp0)) +
        (s.pts > 0 ? row('Puntos libres', s.pts, '#f0b429') : '') +
        (ov.rst && ov.rst.n ? row('Auto /reset', ov.rst.n >= 3 ? 'falló x3' : 'intento ' + ov.rst.n, ov.rst.n >= 3 ? '#f85149' : '#d29922') : '') +
        (ov.mv && ov.mv.n ? row('Auto /move', ov.mv.done ? 'hecho ✓' : 'intento ' + ov.mv.n, ov.mv.done ? '#3fb950' : '#d29922') : '');
    } catch (e) {
      console.warn('[MH] mh-stats:', e);
    }
  });

  // ---- MOBS: lista viva + heatmap por mapa ----
  const mobs = new Map();
  const heat = { map: null, h: new Uint8Array(65536), i: new Uint8Array(65536), names: [], dirty: false, loading: false, saved: 0 };
  window.addEventListener('mh-mobs', async (ev) => {
    try {
      const d = JSON.parse(ev.detail), now = Date.now();
      const enc = (u) => { let s = ''; for (let j = 0; j < u.length; j += 8192) s += String.fromCharCode.apply(null, u.subarray(j, j + 8192)); return btoa(s); };
      const dec = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
      const dump = () => JSON.stringify({ n: heat.names, h: enc(heat.h), i: enc(heat.i) });

      if (heat.map !== d.map) {
        if (heat.loading) return;
        heat.loading = true;
        try {
          if (heat.map != null && heat.dirty) await chrome.storage.local.set({ ['heat:' + heat.map]: dump() });
          const raw = (await chrome.storage.local.get('heat:' + d.map))['heat:' + d.map];
          const o = raw ? JSON.parse(raw) : null;
          heat.h = o ? dec(o.h) : new Uint8Array(65536);
          heat.i = o ? dec(o.i) : new Uint8Array(65536);
          heat.names = o ? o.n : []; heat.map = d.map; heat.dirty = false; heat.saved = now; mobs.clear();
        } finally { heat.loading = false; }
      }

      const prev = new Map(mobs); mobs.clear();
      for (const [id, n, x, y] of d.list) {
        mobs.set(id, [n, x, y]);
        const pv = prev.get(id);
        if ((pv && pv[1] === x && pv[2] === y) || x < 0 || y < 0 || x > 255 || y > 255) continue;
        let ni = heat.names.indexOf(n); if (ni < 0) ni = heat.names.push(n) - 1;
        if (ni > 254) continue;
        const c = y * 256 + x;
        if (heat.h[c] < 255) heat.h[c]++;
        heat.i[c] = ni; heat.dirty = true;
      }
      if (heat.dirty && now - heat.saved > 20000) {
        heat.saved = now; heat.dirty = false;
        chrome.storage.local.set({ ['heat:' + heat.map]: dump() });
      }
    } catch (_) { }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.target !== 'content' || msg.type !== 'getState') return;
    if (!tracked.size && !me) return;
    const now = Date.now();
    const m = getMe();
    const players = [];
    for (const [, t] of tracked) {
      if (now - t.lastSeen > cfg.ttl * 1000) continue;
      players.push({
        n: t.name, x: t.x, y: t.y, src: t.src,
        age: now - t.lastSeen,
        dist: Math.round(Math.hypot(t.x - m.x, t.y - m.y))
      });
    }
    sendResponse({
      ok: true, me: m, map: me?.map ?? null, players, lastData, walking: !!walkTimer || !!followTimer, walkMsg,
      route: walkPath ? walkPath.map((n) => [n.x, n.y]) : null, routeIdx: walkIdx, mobs: [...mobs.values()]
    });
  });

  // ---- ESP: puente hacia el overlay en MAIN world ----
  const espToMain = (msg) => window.dispatchEvent(
    new CustomEvent('mh-esp', { detail: JSON.stringify(msg) })
  );

  window.addEventListener('mh-esp-clickthrough', (ev) => {
    try {
      const { clickable } = JSON.parse(ev.detail);
      const c = document.getElementById('__mh_esp_overlay');
      if (c) c.style.pointerEvents = clickable ? 'auto' : 'none';
    } catch (_) { }
  });

  chrome.storage.local.get(['espEnabled', 'espCfg'], (c) => {
    espToMain({ type: 'toggle', value: !!c.espEnabled });
    if (c.espCfg) espToMain({ type: 'cfg', value: c.espCfg });
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch.espEnabled) espToMain({ type: 'toggle', value: !!ch.espEnabled.newValue });
    if (ch.espCfg) espToMain({ type: 'cfg', value: ch.espCfg.newValue || {} });
  });

  // ================= FULL AUTO =================
  const AUTO = {
    enabled: false,
    user: '', pass: '',
    charName: '',
    lorenciaSpot: { x: 202, y: 124, untilLv: 13 },
    devias3Spot: { x: 225, y: 217 },
    icarusSpot: { x: 46, y: 199, untilLv: 400 },
    devias3Cmd: '/move devias3',
    icarusCmd: '/move icarus',
    icarusLv: { _default: 170, gm: 113 },
    phase: 'unknown',
    cls: '', lv: 0, charLevel: 0, map: null,
    lastAction: 0, enterTries: 0,
    holding: false,
    holdSpot: null,
    lastMoveCmd: null,
    lastMoveAt: 0,
    lastMoveMap: null,
    pendingMoveUntil: 0,
    icarusMap: 10,
    _warnedMaps: null,
  };

  chrome.storage.local.get('autoCfg', (c) => { if (c.autoCfg) Object.assign(AUTO, c.autoCfg); });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.autoCfg) Object.assign(AUTO, ch.autoCfg.newValue || {});
    if (area === 'local' && ch.autoEnabled) AUTO.enabled = !!ch.autoEnabled.newValue;
  });
  chrome.storage.local.get('autoEnabled', (c) => AUTO.enabled = !!c.autoEnabled);

  window.addEventListener('mh-phase', (ev) => {
    try {
      const { phase } = JSON.parse(ev.detail);
      if (AUTO.phase !== phase) {
        console.log('[MH-AUTO] fase:', AUTO.phase, '→', phase);
        AUTO.phase = phase;
        AUTO.lastAction = 0;
        if (phase === 'game') AUTO.enterTries = 0;
        if (phase === 'charselect') {
          AUTO.lv = 0;
          AUTO.map = null;
          unholdMouse();
        }
      }
    } catch (_) { }
  });

  let charInfoResolve = null;
  window.addEventListener('mh-char-info', (ev) => {
    try { charInfoResolve?.(JSON.parse(ev.detail)); } catch (_) { }
  });
  const queryCharInfo = () => new Promise((res) => {
    charInfoResolve = res;
    window.dispatchEvent(new CustomEvent('mh-query-char'));
    setTimeout(() => res(null), 800);
  });

  const trustedEnter = () => chrome.runtime.sendMessage({ target: 'bg', type: 'pressEnter' }).catch(() => { });
  const typeInto = (el, text) => {
    if (!el) return;
    el.focus(); el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const stopHoldThenChat = async (text) => {
    await chrome.runtime.sendMessage({ target: 'bg', type: 'stop' }).catch(() => { });
    await new Promise(r => setTimeout(r, 600));
    await chrome.runtime.sendMessage({ target: 'bg', type: 'chat', text }).catch(() => { });
  };

  const holdMouse = async () => {
    if (AUTO.holding) return;
    const cfg = await chrome.storage.local.get(['button', 'x', 'y', 'repeat']);
    chrome.runtime.sendMessage({
      target: 'bg', type: 'start',
      button: cfg.button || 'right',
      x: cfg.x ?? null,
      y: cfg.y ?? null,
      repeat: cfg.repeat ?? 300
    }).catch(() => { });
    AUTO.holding = true;
    console.log('[MH-AUTO] HOLD ON →', cfg.x, cfg.y, cfg.button, 'repeat', cfg.repeat);
  };

  const unholdMouse = async () => {
    if (!AUTO.holding) return;
    chrome.runtime.sendMessage({ target: 'bg', type: 'stop' }).catch(() => { });
    AUTO.holding = false;
    AUTO.holdSpot = null;
    console.log('[MH-AUTO] HOLD OFF');
  };

  async function doLogin() {
    if (Date.now() - AUTO.lastAction < 3000) return;
    AUTO.lastAction = Date.now();
    const userEl = document.querySelector('input[type="text"], input[name="user"], input[name="username"]');
    const passEl = document.querySelector('input[type="password"]');
    if (!userEl || !passEl) return;
    typeInto(userEl, AUTO.user);
    typeInto(passEl, AUTO.pass);
    await new Promise(r => setTimeout(r, 200));
    trustedEnter();
  }

  async function doCharSelect() {
    if (Date.now() - AUTO.lastAction < 3000) return;
    AUTO.lastAction = Date.now();
    const info = await queryCharInfo();
    if (!info) return;

    const want = (AUTO.charName || '').toLowerCase();
    if (want && (info.focused || '').toLowerCase() !== want) {
      const exists = info.all.some(c => c.Name.toLowerCase() === want);
      if (!exists) { console.error('[MH-AUTO] no existe:', AUTO.charName); return; }
      window.dispatchEvent(new CustomEvent('mh-select-char', { detail: JSON.stringify({ name: AUTO.charName }) }));
      await new Promise(r => setTimeout(r, 1200));
      const i2 = await queryCharInfo();
      if ((i2?.focused || '').toLowerCase() !== want) { console.warn('[MH-AUTO] no cambié'); return; }
    }

    const cur = info.all.find(c => c.Name === (info.focused || '')) || info.all[0];
    AUTO.cls = /^mg/i.test(cur?.Name || '') ? 'magic gladiator' : 'normal';
    AUTO.charLevel = cur?.Level ?? 0;

    AUTO.enterTries = (AUTO.enterTries || 0) + 1;
    if (AUTO.enterTries > 6) { AUTO.enterTries = 0; return; }
    window.dispatchEvent(new CustomEvent('mh-enter-game'));
    await new Promise(r => setTimeout(r, 2000));
  }

  const icarusTarget = () =>
    AUTO.cls === 'magic gladiator'
      ? (AUTO.icarusLv?.gm ?? 113)
      : (AUTO.icarusLv?._default ?? 170);

  const canSendMove = (cmd) => {
    const now = Date.now();
    if (now < AUTO.pendingMoveUntil) return false;
    if (AUTO.lastMoveCmd === cmd && AUTO.lastMoveMap === AUTO.map) return false;
    return true;
  };

  const markMoveSent = (cmd) => {
    AUTO.lastMoveCmd = cmd;
    AUTO.lastMoveMap = AUTO.map;
    AUTO.lastMoveAt = Date.now();
    AUTO.pendingMoveUntil = Date.now() + 30000;
  };

  async function doIngame() {
    const m = getMe();
    if (!m) return;
    const map = me?.map;

    if (map !== AUTO.map) {
      console.log('[MH-AUTO] cambio de mapa:', AUTO.map, '→', map);
      AUTO.map = map;
      AUTO.lastMoveCmd = null;
      AUTO.lastMoveMap = null;
      AUTO.pendingMoveUntil = 0;
      AUTO.holdSpot = null;
    }

    const now = Date.now();
    const walking = !!walkTimer || !!followTimer;

    if (walking && AUTO.holding) { await unholdMouse(); return; }
    if (now - AUTO.lastAction < 3000) return;

    if (map === 0) {
      const { x, y, untilLv } = AUTO.lorenciaSpot;
      if ((AUTO.lv ?? 0) >= untilLv) {
        if (!canSendMove(AUTO.devias3Cmd)) return;
        markMoveSent(AUTO.devias3Cmd);
        AUTO.lastAction = now;
        await unholdMouse();
        await stopHoldThenChat(AUTO.devias3Cmd);
        waitMapThenGo(2, AUTO.devias3Spot.x, AUTO.devias3Spot.y);   // ⬅️ NUEVO
        return;
      }
      if (walking) return;
      const dist = Math.hypot(m.x - x, m.y - y);
      if (dist > 5) {
        if (AUTO.holding) await unholdMouse();
        AUTO.lastAction = now;
        goTo(x, y);
      } else {
        if (!AUTO.holding) {
          AUTO.holdSpot = { x, y, map: 0 };
          try { await holdMouse(); } catch (e) { console.error('[MH-AUTO] holdMouse error:', e); }
        }
      }
      return;
    }
    if (map === 2) {
      const { x, y } = AUTO.devias3Spot;
      const target = icarusTarget();
      if ((AUTO.lv ?? 0) >= target) {
        if (!canSendMove(AUTO.icarusCmd)) return;
        markMoveSent(AUTO.icarusCmd);
        AUTO.lastAction = now;
        await unholdMouse();
        await stopHoldThenChat(AUTO.icarusCmd);
        waitMapThenGo(AUTO.icarusMap, AUTO.icarusSpot.x, AUTO.icarusSpot.y);   // ⬅️ NUEVO
        return;
      }
      if (walking) return;
      const dist = Math.hypot(m.x - x, m.y - y);
      if (dist > 5) {
        if (AUTO.holding) await unholdMouse();
        AUTO.lastAction = now;
        goTo(x, y);
      } else {
        if (!AUTO.holding) {
          AUTO.holdSpot = { x, y, map: 2 };
          try { await holdMouse(); } catch (e) { console.error('[MH-AUTO] holdMouse error:', e); }
        }
      }
      return;
    }

    if (map === AUTO.icarusMap) {
      const { x, y, untilLv } = AUTO.icarusSpot;
      if ((AUTO.lv ?? 0) >= untilLv) {
        if (AUTO.holding) await unholdMouse();
        return;
      }
      if (walking) return;
      const dist = Math.hypot(m.x - x, m.y - y);
      if (dist > 5) {
        if (AUTO.holding) await unholdMouse();
        AUTO.lastAction = now;
        goTo(x, y);
      } else {
        if (!AUTO.holding) {
          AUTO.holdSpot = { x, y, map };
          try { await holdMouse(); } catch (e) { console.error('[MH-AUTO] holdMouse error:', e); }
        }
      }
      return;
    }

    if (!AUTO._warnedMaps) AUTO._warnedMaps = new Set();
    if (!AUTO._warnedMaps.has(map)) {
      AUTO._warnedMaps.add(map);
      console.warn('[MH-AUTO] mapa no configurado:', map);
    }
  }

  // ================== LOOP PRINCIPAL ==================
  setInterval(() => {
    if (!AUTO.enabled) return;
    try {
      if (walkTimer && me) {
        if (!AUTO._lastPos || AUTO._lastPos.x !== me.x || AUTO._lastPos.y !== me.y) {
          AUTO._lastPos = { x: me.x, y: me.y, t: Date.now() };
        } else if (Date.now() - AUTO._lastPos.t > 2500) {
          stopWalk('auto-stuck', false);
          AUTO._lastPos = null;
        }
      }

      switch (AUTO.phase) {
        case 'login': doLogin(); break;
        case 'charselect': doCharSelect(); break;
        case 'game': doIngame(); break;
      }
      chrome.storage.local.set({
        autoState: {
          phase: AUTO.phase, lv: AUTO.lv, map: AUTO.map,
          cls: AUTO.cls, charLevel: AUTO.charLevel, holding: AUTO.holding
        }
      }).catch(() => { });
    } catch (e) { console.warn('[MH-AUTO]', e); }
  }, 1500);

})();