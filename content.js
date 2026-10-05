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
  const cfg = { watch: [], minDist: 0, ttl: 15, meX: 226, meY: 236, resetLv: 400 };
  const AUTO_MOVE = { lv: 170, cmd: '/move icarus', map: 10, x: 46, y: 199, maxTries: 3, cdMs: 45000 };
  let me = null;                     // posición propia detectada por el interceptor { x, y, ts }
  let lastData = 0;

  // Config viva desde storage (la edita la ventana del radar)
  const readCfg = () => chrome.storage.local
    .get(['watchlist', 'radarMinDist', 'radarTTL', 'radarMeX', 'radarMeY', 'resetLv'])

    .then((c) => {
      cfg.watch = (c.watchlist || '').split(',').map((n) => n.trim().toLowerCase()).filter(Boolean);
      cfg.minDist = +c.radarMinDist || 0;
      cfg.ttl = Math.max(3, +c.radarTTL || 15);
      cfg.meX = +(c.radarMeX ?? 226);
      cfg.meY = +(c.radarMeY ?? 236);
      cfg.resetLv = +(c.resetLv ?? 400);
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

      // for (const e of list) {
      //   let t = tracked.get(e.n);
      const seen = {};
      for (const e of list) {
        const k = seen[e.n] = (seen[e.n] ?? -1) + 1;
        const key = k ? `${e.n}#${k}` : e.n;
        let t = tracked.get(key);
        const wasPresent = !!t && now - t.lastSeen <= ttlMs;
        // if (!t) { t = { lastAlert: 0 }; tracked.set(key, t); }
        if (!t) { t = { lastAlert: 0 }; tracked.set(key, t); }
        if (!wasPresent) { t.firstSeen = now; t.notified = false; }
        // t.x = e.x; t.y = e.y; t.lastSeen = now; t.src = src;
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
    // if (was && halt) chrome.runtime.sendMessage({
    //   target: 'bg', type: 'keys', releaseMouse: false,
    //   seq: [{ click: [Math.round(innerWidth / 2), Math.round(innerHeight / 2)] }]
    // }).catch(() => { });
    if (was && halt && me) window.dispatchEvent(new CustomEvent('mh-moveto', { detail: JSON.stringify({ x: me.x, y: me.y }) }));
  };

  async function goTo(tx, ty, near = 3) {   // ⬅️ 3 tiles de tolerancia
    // stopWalk('', false);
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

      // progreso: nodo de la ruta más cercano que se vea en línea recta (solo hacia adelante; un muro lo descarta)
      const lim = Math.min(path.length, idx + wcfg.lookahead * 2);
      let bd = 1e9;
      for (let j = idx; j < lim; j++) {
        const d = Math.hypot(path[j].x - p.x, path[j].y - p.y);
        if (d < bd && los(p.x, p.y, path[j].x, path[j].y)) { bd = d; idx = j; }
      }
      walkIdx = idx;

      // atascado = misma casilla por maxStill ticks
      const pk = p.x + ',' + p.y;
      still = pk === lastKey ? still + 1 : 0; lastKey = pk;
      if (still >= wcfg.maxStill) return stopWalk(`atascado en (${p.x}, ${p.y})`, true);

      // waypoint: el nodo más lejano (hasta lookahead) con línea recta libre
      let wp = path[Math.min(idx + 1, path.length - 1)];
      for (let j = Math.min(idx + wcfg.lookahead, path.length - 1); j > idx; j--) {
        if (los(p.x, p.y, path[j].x, path[j].y)) { wp = path[j]; break; }
      }

      // manda destino nuevo cuando ya casi llegó al anterior (sin pausa), o reintenta si lleva ~0.6 s quieto
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
      if (walkTimer && dest && Math.hypot(t.x - dest.x, t.y - dest.y) < 4) return; // sigue yendo al mismo sitio
      dest = { x: t.x, y: t.y }; routing = true;
      goTo(t.x, t.y, 2.5).finally(() => { routing = false; });
    }, 2500);
  }

  // ---- AUTO-MOVE: tras el comando /move, espera el terreno del mapa nuevo y camina a (x, y) ----
  function waitMapThenGo() {
    const t0 = Date.now();
    const wt = setInterval(async () => {
      const m = me, nowT = Date.now();
      if (nowT - t0 > 60000) { clearInterval(wt); ov.mv.going = false; return; }
      if (!m || m.map == null) return;

      // ❌ antes: settled = terr && (m.map !== prevMap || nowT - t0 > 3000)
      // ✅ ahora: exige que el mapa sea EXACTAMENTE el de destino
      if (m.map !== AUTO_MOVE.map) return;   // sigue esperando el /move

      const terr = (await chrome.storage.local.get('map:' + m.map))['map:' + m.map];
      if (!terr) return;                     // terreno aún no cargado

      clearInterval(wt);
      ov.mv.done = true;
      goTo(AUTO_MOVE.x, AUTO_MOVE.y).finally(() => { ov.mv.going = false; });
    }, 800);
  }



  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.target !== 'content') return;
    if (msg.type === 'goto' && me) { clearInterval(followTimer); followTimer = null; goTo(msg.x, msg.y); }
    if (msg.type === 'follow' && me) follow(msg.name);
    if (msg.type === 'stopwalk') stopWalk();
  });

  // ---- OVERLAY: stats del personaje (esquina sup. izq., no captura el mouse; Alt+O lo oculta) ----
  const ov = { el: null, name: null, exp0: 0, zen0: 0, t0: 0, samples: [], lastExp: null };
  window.addEventListener('keydown', (e) => { if (e.altKey && e.key.toLowerCase() === 'o' && ov.el) ov.el.style.display = ov.el.style.display === 'none' ? '' : 'none'; }, true);


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
      if (ov.name !== s.n) Object.assign(ov, { name: s.n, exp0: s.exp, zen0: s.zen, t0: now, samples: [] }); // personaje nuevo = sesión nueva
      // Reset detectado: la EXP total nunca baja en una sesión; si bajó, empezar de cero
      if (ov.lastExp != null && s.exp < ov.lastExp) {
        Object.assign(ov, { exp0: s.exp, zen0: s.zen, t0: now, samples: [] });
        chrome.runtime.sendMessage({ target: 'bg', type: 'stop' }).catch(() => { });
        AUTO.holding = false;
        AUTO.holdSpot = null;
      }
      ov.lastExp = s.exp;
      if (!ov.samples.length || now - ov.samples[ov.samples.length - 1].t >= 5000) ov.samples.push({ t: now, exp: s.exp, zen: s.zen });
      while (ov.samples[0] && now - ov.samples[0].t > 600000) ov.samples.shift(); // ventana de 10 min

      const f = ov.samples[0], dh = (now - f.t) / 3600000, ok = dh >= 0.0083; // mínimo 30 s de datos
      const expH = ok ? Math.max(0, (s.exp - f.exp) / dh) : 0, zenH = ok ? (s.zen - f.zen) / dh : 0;
      const eta = expH > 0 ? (s.next - s.exp) / expH : 0;
      const sh = (n) => Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
      const row = (a, b, c) => `<div style="display:flex;justify-content:space-between;gap:12px"><span style="color:#8b949e">${a}</span><span style="color:${c || '#3fb950'}">${b}</span></div>`;
      const bar = (v, m, c) => `<div style="height:4px;background:#161b22;margin:1px 0 3px"><div style="height:100%;width:${Math.max(0, Math.min(100, m ? v / m * 100 : 0))}%;background:${c}"></div></div>`;
      const pct = s.next > s.cur ? (s.exp - s.cur) / (s.next - s.cur) * 100 : 0;
      const ses = (now - ov.t0) / 60000, m = getMe();
      const near = [...tracked.values()].filter((t) => now - t.lastSeen <= cfg.ttl * 1000).length;
      const hpLow = s.mhp && s.hp / s.mhp < 0.3;
      const nm = String(s.n).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      // AUTO /reset: al llegar al nivel configurado escribe /reset en el chat (máx. 3 intentos, 45 s entre cada uno)
      // Envía un mensaje de chat sin tocar mouse ni teclado:
      // 1) el interceptor (MAIN world) escribe en el input del juego
      // 2) el background manda un Enter "trusted" con chrome.debugger
      const sendChat = (text) =>
        chrome.runtime.sendMessage({ target: 'bg', type: 'chat', text }).catch(() => { });

      const stopHoldThenChat = async (text) => {
        await chrome.runtime.sendMessage({ target: 'bg', type: 'stop' }).catch(() => { });
        await new Promise(r => setTimeout(r, 600));
        await sendChat(text);
      };

      if (!cfg.resetLv || s.lv < cfg.resetLv) ov.rst = { n: 0, t: 0 };
      else if (!s.lost) {
        ov.rst ??= { n: 0, t: 0 };

        if (ov.rst.n < 3 && now - ov.rst.t > 45000) {
          ov.rst.n++; ov.rst.t = now;
          if (walkTimer || followTimer) stopWalk('auto-reset', false);
          (async () => {
            await stopHoldThenChat('/reset');
          })();
        }
      }

      // AUTO /MOVE: al llegar al nivel configurado escribe el comando (p.ej. /move icarus) y luego autowalk a (x, y)
      if (s.lv < AUTO_MOVE.lv || s.lost) {
        ov.mv = { n: 0, t: 0, done: false, going: false, map: curMap };
      } else {
        ov.mv ??= { n: 0, t: 0, done: false, going: false, map: curMap };
        if (!ov.mv.done && !ov.mv.going && ov.mv.n < AUTO_MOVE.maxTries && now - ov.mv.t > AUTO_MOVE.cdMs) {
          ov.mv.n++; ov.mv.t = now; ov.mv.going = true;
          if (walkTimer || followTimer) stopWalk('auto-move', false);
          (async () => {
            await stopHoldThenChat(AUTO_MOVE.cmd);
            waitMapThenGo();
          })();
        }

      }
      // ---- TIEMPO ESTIMADO AL PRÓXIMO RESET ----
      const base = (L) =>
        (L + 8) * (L - 1) ** 2 +
        (L > 255 ? 100 * (L - 247) * (L - 256) ** 2 : 0);

      const tgt = cfg.resetLv || 400;

      // Calibrar la curva de EXP usando el nivel actual.
      const nextBase = base(s.lv + 1);
      const mul = nextBase > 0 ? s.next / nextBase : 0;

      // EXP absoluta estimada necesaria para llegar al reset.
      const resetExp = base(tgt) * mul;

      // EXP restante.
      const resetLeft = Math.max(0, resetExp - s.exp);

      // Horas restantes según el ritmo actual de EXP.
      const resetHours = expH > 0 ? resetLeft / expH : Infinity;

      // Formato: 18h 37m
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

      // Hora estimada del reset.
      const fmtClock = (date) => {
        let h = date.getHours();
        const min = String(date.getMinutes()).padStart(2, '0');
        const suffix = h >= 12 ? 'pm' : 'am';

        h %= 12;
        if (h === 0) h = 12;

        return `${h}:${min} ${suffix}`;
      };

      const resetDate = Number.isFinite(resetHours)
        ? new Date(now + resetHours * 3600000)
        : null;

      const rEta =
        s.lv >= tgt
          ? 'AHORA'
          : !ok
            ? 'midiendo…'
            : expH <= 0
              ? 'sin EXP'
              : `${fmtTime(resetHours)} (${fmtClock(resetDate)})`;
      ov.el.innerHTML =

        (s.lost ? '<div style="color:#fff;background:#da3633;text-align:center;font-weight:700;margin-bottom:3px">DESCONECTADO</div>' : '') +
        `<div style="color:#f0b429;font-weight:700">${nm} · Lv ${s.lv}${s.ml ? ' +' + s.ml : ''}</div>` +
        (s.res != null ? row('Resets', s.res, '#58a6ff') : '') + (s.gres != null ? row('Grand resets', s.gres, '#58a6ff') : '') +
        row('EXP', pct.toFixed(1) + '%') + bar(s.exp - s.cur, s.next - s.cur, '#58a6ff') +
        row('EXP/h (10m)', ok ? sh(expH) : '…') + row('Próx. nivel', eta > 0 && eta < 100 ? Math.floor(eta) + 'h ' + Math.round(eta % 1 * 60) + 'm' : '—') +
        // tiempo para el próximo reset
        row('Tiempo p/ reset', rEta, '#f0b429') +
        row('Sesión', Math.floor(ses / 60) + 'h ' + Math.round(ses % 60) + 'm · +' + sh(s.exp - ov.exp0)) +
        row('Zen/h', ok ? sh(zenH) : '…', '#d29922') +
        row('HP', s.hp + '/' + s.mhp, hpLow ? '#f85149' : '#3fb950') + bar(s.hp, s.mhp, hpLow ? '#f85149' : '#3fb950') +
        row('MP', s.mp + '/' + s.mmp, '#58a6ff') + bar(s.mp, s.mmp, '#58a6ff') +
        (s.msd ? row('SD', s.sd + '/' + s.msd, '#a371f7') + bar(s.sd, s.msd, '#a371f7') : '') +
        (s.mag ? row('AG', s.ag + '/' + s.mag, '#d29922') + bar(s.ag, s.mag, '#d29922') : '') +
        (s.pts > 0 ? row('Puntos libres', s.pts, '#f0b429') : '') +
        row('Pos', `(${m.x}, ${m.y}) · map ${me?.map ?? '?'}`, '#c9d1d9') +
        row('Jugadores cerca', near, '#c9d1d9') +

        (ov.rst && ov.rst.n ? row('Auto /reset', ov.rst.n >= 3 ? 'falló x3' : 'intento ' + ov.rst.n, ov.rst.n >= 3 ? '#f85149' : '#d29922') : '') +
        (ov.mv && ov.mv.n ? row('Auto /move', ov.mv.done ? 'hecho ✓' : 'intento ' + ov.mv.n, ov.mv.done ? '#3fb950' : '#d29922') : '') +
        (s.helper != null ? row('Helper', s.helper ? 'ON' : 'OFF', s.helper ? '#3fb950' : '#f85149') : '');
    } catch (_) { }
  });



  // ---- MOBS: lista viva + heatmap por mapa (cuenta cada mob nuevo o que cambia de tile; guarda 'heat:<map>' cada 20 s) ----
  const mobs = new Map(); // netId -> [nombre, x, y]
  const heat = { map: null, h: new Uint8Array(65536), i: new Uint8Array(65536), names: [], dirty: false, loading: false, saved: 0 };
  window.addEventListener('mh-mobs', async (ev) => {
    try {
      const d = JSON.parse(ev.detail), now = Date.now();
      const enc = (u) => { let s = ''; for (let j = 0; j < u.length; j += 8192) s += String.fromCharCode.apply(null, u.subarray(j, j + 8192)); return btoa(s); };
      const dec = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
      const dump = () => JSON.stringify({ n: heat.names, h: enc(heat.h), i: enc(heat.i) });

      if (heat.map !== d.map) { // cambio de mapa: guarda el anterior y carga el nuevo
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
      if (heat.dirty && now - heat.saved > 20000) { heat.saved = now; heat.dirty = false; chrome.storage.local.set({ ['heat:' + heat.map]: dump() }); }
    } catch (_) { }
  });

  // La ventana del radar pide el estado. Si este frame no tiene datos, no responde
  // (así gana el frame/pestaña que sí los tiene).
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.target !== 'content' || msg.type !== 'getState') return;
    if (!tracked.size && !me) return;
    const now = Date.now();
    const m = getMe();
    const players = [];
    // for (const [n, t] of tracked) {
    for (const [, t] of tracked) {
      if (now - t.lastSeen > cfg.ttl * 1000) continue;
      players.push({
        // n, x: t.x, y: t.y, src: t.src,
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

  // Clickthrough: el content ajusta pointer-events del canvas (que vive en MAIN)
  window.addEventListener('mh-esp-clickthrough', (ev) => {
    try {
      const { clickable } = JSON.parse(ev.detail);
      const c = document.getElementById('__mh_esp_overlay');
      if (c) c.style.pointerEvents = clickable ? 'auto' : 'none';
    } catch (_) { }
  });

  // Estado inicial y cambios desde storage
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
    icarusSpot: { x: 46, y: 199, untilLv: 400 },  // ⬅️ ajustar coords si difieren
    devias3Cmd: '/move devias3',
    icarusCmd: '/move icarus',
    icarusLv: { _default: 170, gm: 113 },
    phase: 'unknown',
    cls: '', lv: 0, charLevel: 0, map: null,
    lastAction: 0, enterTries: 0,
    holding: false,          // ⬅️ NUEVO
    holdSpot: null,          // ⬅️ NUEVO: coords del spot donde está holdeando
    lastMoveCmd: null,        // ⬅️ NUEVO
    lastMoveAt: 0,            // ⬅️ NUEVO
    lastMoveMap: null,        // ⬅️ NUEVO
    pendingMoveUntil: 0,      // ⬅️ NUEVO: timestamp hasta el que NO volver a mandar /move
    icarusMap: 10,
    _warnedMaps: null,   // Set, se crea on-demand
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
          unholdMouse();     // ⬅️ NUEVO: si volvemos a charselect, soltar
        }
      }
    } catch (_) { }
  });

  // if (ov.lastExp != null && s.exp < ov.lastExp) {
  //   Object.assign(ov, { exp0: s.exp, zen0: s.zen, t0: now, samples: [] });
  //   chrome.runtime.sendMessage({ target: 'bg', type: 'stop' }).catch(() => { });
  //   AUTO.holding = false;      // ⬅️ NUEVO
  //   AUTO.holdSpot = null;      // ⬅️ NUEVO
  // }

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
  // ---- HOLD ON/OFF del mouse para atacar ----
  const holdMouse = async () => {
    console.log('[MH-AUTO] holdMouse() invocado, holding=', AUTO.holding);
    if (AUTO.holding) { console.log('[MH-AUTO] holdMouse: ya estaba holdeando'); return; }

    const cfg = await chrome.storage.local.get(['button', 'x', 'y', 'repeat']);
    console.log('[MH-AUTO] holdMouse: cfg =', cfg);

    // ⬇️ SIN tabId → el background resuelve la pestaña
    chrome.runtime.sendMessage({
      target: 'bg', type: 'start',
      button: cfg.button || 'right',
      x: cfg.x ?? null,
      y: cfg.y ?? null,
      repeat: cfg.repeat ?? 300
    }).then(() => console.log('[MH-AUTO] holdMouse: start enviado'))
      .catch((e) => console.error('[MH-AUTO] holdMouse: error al enviar', e));

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
    console.log('[MH-AUTO] login enviado');
  }

  async function doCharSelect() {
    if (Date.now() - AUTO.lastAction < 3000) return;
    AUTO.lastAction = Date.now();

    const info = await queryCharInfo();
    if (!info) return;

    const want = (AUTO.charName || '').toLowerCase();
    if (want && (info.focused || '').toLowerCase() !== want) {
      const exists = info.all.some(c => c.Name.toLowerCase() === want);
      if (!exists) { console.error('[MH-AUTO] no existe:', AUTO.charName, '· tienes:', info.all.map(c => c.Name)); return; }
      window.dispatchEvent(new CustomEvent('mh-select-char', { detail: JSON.stringify({ name: AUTO.charName }) }));
      await new Promise(r => setTimeout(r, 1200));
      const i2 = await queryCharInfo();
      if ((i2?.focused || '').toLowerCase() !== want) { console.warn('[MH-AUTO] no cambié'); return; }
    }

    const cur = info.all.find(c => c.Name === (info.focused || '')) || info.all[0];
    AUTO.cls = /^mg/i.test(cur?.Name || '') ? 'magic gladiator' : 'normal';
    AUTO.charLevel = cur?.Level ?? 0;
    console.log('[MH-AUTO] char:', cur?.Name, 'lv', cur?.Level, 'cls', AUTO.cls);

    AUTO.enterTries = (AUTO.enterTries || 0) + 1;
    if (AUTO.enterTries > 6) { AUTO.enterTries = 0; return; }
    console.log('[MH-AUTO] entrar (intento ' + AUTO.enterTries + ')');
    window.dispatchEvent(new CustomEvent('mh-enter-game'));
    await new Promise(r => setTimeout(r, 2000));
  }

  const icarusTarget = () =>
    AUTO.cls === 'magic gladiator'
      ? (AUTO.icarusLv?.gm ?? 113)
      : (AUTO.icarusLv?._default ?? 170);
  // ¿Puedo mandar este /move ahora? Bloquea repeticiones durante 30s
  const canSendMove = (cmd) => {
    const now = Date.now();
    if (now < AUTO.pendingMoveUntil) return false;      // bloqueado
    if (AUTO.lastMoveCmd === cmd && AUTO.lastMoveMap === AUTO.map) return false;
    return true;
  };

  const markMoveSent = (cmd) => {
    AUTO.lastMoveCmd = cmd;
    AUTO.lastMoveMap = AUTO.map;
    AUTO.lastMoveAt = Date.now();
    AUTO.pendingMoveUntil = Date.now() + 30000;         // 30s de bloqueo
  };

  async function doIngame() {
    const m = getMe();
    if (!m) return;
    const map = me?.map;


    // Detectar cambio real de mapa
    if (map !== AUTO.map) {
      console.log('[MH-AUTO] cambio de mapa:', AUTO.map, '→', map);
      AUTO.map = map;
      // Al cambiar de mapa, liberar el bloqueo de /move
      AUTO.lastMoveCmd = null;
      AUTO.lastMoveMap = null;
      AUTO.pendingMoveUntil = 0;
      AUTO.holdSpot = null;
    }

    const now = Date.now();
    const walking = !!walkTimer || !!followTimer;
    console.log('[MH-AUTO] doIngame', { map, pos: [m.x, m.y], walking, holding: AUTO.holding, lv: AUTO.lv });

    // Si camina, soltar hold
    if (walking && AUTO.holding) { await unholdMouse(); return; }
    if (now - AUTO.lastAction < 3000) return;
    // ---------- MAP 0 → Lorencia ----------
    if (map === 0) {
      const { x, y, untilLv } = AUTO.lorenciaSpot;

      // A) ¿Ya subió de nivel? → /move devias3
      if ((AUTO.lv ?? 0) >= untilLv) {
        if (!canSendMove(AUTO.devias3Cmd)) return;
        markMoveSent(AUTO.devias3Cmd);
        AUTO.lastAction = now;
        await unholdMouse();
        console.log('[MH-AUTO] Lv', AUTO.lv, '≥', untilLv, '→', AUTO.devias3Cmd);
        await stopHoldThenChat(AUTO.devias3Cmd);
        return;
      }

      // B) Aún no subió → acercarse al spot y hol dear
      if (walking) return;   // si camina, no hacer nada (el siguiente tick evaluará)

      const dist = Math.hypot(m.x - x, m.y - y);
      console.log('[MH-AUTO] Lorencia dist:', dist.toFixed(1), 'pos:', m.x, m.y, 'spot:', x, y, 'holding:', AUTO.holding);

      if (dist > 5) {
        // Lejos → caminar
        if (AUTO.holding) await unholdMouse();
        AUTO.lastAction = now;
        goTo(x, y);
        console.log('[MH-AUTO] Lorencia →', x, y);
      } else {
        // Cerca → HOLD
        if (!AUTO.holding) {
          AUTO.holdSpot = { x, y, map: 0 };
          try { await holdMouse(); }
          catch (e) { console.error('[MH-AUTO] holdMouse error:', e); }
        }
      }
      return;
    }

    // ---------- MAP 2 → Devias3 ----------
    if (map === 2) {
      const { x, y } = AUTO.devias3Spot;
      const target = icarusTarget();

      if ((AUTO.lv ?? 0) >= target) {
        if (!canSendMove(AUTO.icarusCmd)) return;
        markMoveSent(AUTO.icarusCmd);
        AUTO.lastAction = now;
        await unholdMouse();
        console.log('[MH-AUTO] Lv', AUTO.lv, '≥', target, '(' + AUTO.cls + ') →', AUTO.icarusCmd);
        await stopHoldThenChat(AUTO.icarusCmd);
        return;
      }

      if (walking) return;

      const dist = Math.hypot(m.x - x, m.y - y);
      console.log('[MH-AUTO] Devias3 dist:', dist.toFixed(1), 'pos:', m.x, m.y, 'spot:', x, y, 'holding:', AUTO.holding);

      if (dist > 5) {
        if (AUTO.holding) await unholdMouse();
        AUTO.lastAction = now;
        goTo(x, y);
        console.log('[MH-AUTO] Devias3 →', x, y);
      } else {
        if (!AUTO.holding) {
          AUTO.holdSpot = { x, y, map: 2 };
          try { await holdMouse(); }
          catch (e) { console.error('[MH-AUTO] holdMouse error:', e); }
        }
      }
      return;
    }

    // ---------- Icarus ----------
    if (map === AUTO.icarusMap) {
      const { x, y, untilLv } = AUTO.icarusSpot;

      if ((AUTO.lv ?? 0) >= untilLv) {
        // ya llegó a 400 → esperar auto-reset
        if (AUTO.holding) await unholdMouse();
        console.log('[MH-AUTO] Lv', AUTO.lv, '≥', untilLv, '→ esperando auto-reset');
        return;
      }

      if (walking) return;

      const dist = Math.hypot(m.x - x, m.y - y);
      console.log('[MH-AUTO] Icarus dist:', dist.toFixed(1), 'pos:', m.x, m.y, 'spot:', x, y, 'holding:', AUTO.holding);

      if (dist > 5) {
        if (AUTO.holding) await unholdMouse();
        AUTO.lastAction = now;
        goTo(x, y);
        console.log('[MH-AUTO] Icarus →', x, y);
      } else {
        if (!AUTO.holding) {
          AUTO.holdSpot = { x, y, map };
          try { await holdMouse(); }
          catch (e) { console.error('[MH-AUTO] holdMouse error:', e); }
        }
      }
      return;
    }

    // Mapa no configurado
    if (!AUTO._warnedMaps) AUTO._warnedMaps = new Set();
    if (!AUTO._warnedMaps.has(map)) {
      AUTO._warnedMaps.add(map);
      console.warn('[MH-AUTO] mapa no configurado:', map);
    }
  }   // ⬅️ AQUÍ CIERRA doIngame

  // ================== LOOP PRINCIPAL ==================
  setInterval(() => {
    if (!AUTO.enabled) return;
    try {
      // forzar stopWalk si el personaje está quieto pero el walk sigue activo
      if (walkTimer && me) {
        if (!AUTO._lastPos || AUTO._lastPos.x !== me.x || AUTO._lastPos.y !== me.y) {
          AUTO._lastPos = { x: me.x, y: me.y, t: Date.now() };
        } else if (Date.now() - AUTO._lastPos.t > 2500) {
          console.warn('[MH-AUTO] forzando stopWalk (quieto 2.5s)');
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

})();   // ⬅️ cierre del IIFE