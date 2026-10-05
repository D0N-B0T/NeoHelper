const $ = (id) => document.getElementById(id);
const DEFAULT_QUICK = 'Char:c, Inv:v, Skill:s, Party:p, Guild:g, Map:m';
const GAME = '*://*.mu.mormon.garden/*';

(async () => {
  const c = await chrome.storage.local.get([
    'button', 'x', 'y', 'repeat', 'quick', 'chatMsg', 'statPts', 'chatX', 'chatY', 'resetLv',
    'watchlist', 'radarMinDist', 'radarTTL', 'radarMeX', 'radarMeY', 'savedLocs', 'uiTile', 'espCfg', 'autoCfg'
  ]);

  // ---------- carga inicial ----------
  $('btn').value = c.button || 'right';
  $('x').value = c.x ?? '';
  $('y').value = c.y ?? '';
  $('rep').value = c.repeat ?? 300;
  $('resetlv').value = c.resetLv ?? 400;
  if (c.chatMsg) $('chat').value = c.chatMsg;
  if (c.chatX != null) $('chatx').value = c.chatX;
  if (c.chatY != null) $('chaty').value = c.chatY;
  if (c.statPts != null) $('pts').value = c.statPts;
  $('quick-cfg').value = c.quick || DEFAULT_QUICK;
  if (c.watchlist) $('watchlist').value = c.watchlist;
  if (c.radarMinDist != null) $('radar-dist').value = c.radarMinDist;
  if (c.radarTTL != null) $('radar-ttl').value = c.radarTTL;
  if (c.radarMeX != null) $('me-x').value = c.radarMeX;
  if (c.radarMeY != null) $('me-y').value = c.radarMeY;
  if (c.espCfg) {
    $('esp-max-dist').value = c.espCfg.maxDist ?? 0;
    $('esp-names').value = (c.espCfg.names || []).join(', ');
    $('esp-black').value = (c.espCfg.showNames || []).join(', ');
  }
  if (c.autoCfg) {
    $('auto-user').value = c.autoCfg.user || '';
    $('auto-pass').value = c.autoCfg.pass || '';
    $('auto-char').value = c.autoCfg.charName || '';
    $('auto-lv-gm').value = c.autoCfg.icarusLv?.gm ?? 113;
    $('auto-lv-def').value = c.autoCfg.icarusLv?._default ?? 170;
  }

  // ---------- tiles / inspector ----------
  const selectTile = (t) => {
    document.querySelectorAll('.tile').forEach((b) => b.classList.toggle('sel', b.dataset.p === t));
    document.querySelectorAll('.insp .p').forEach((p) => p.classList.toggle('act', p.id === 'p-' + t));
    chrome.storage.local.set({ uiTile: t });
  };
  document.querySelectorAll('.tile').forEach((b) => { b.onclick = () => selectTile(b.dataset.p); });
  selectTile(c.uiTile || 'hold');

  // ---------- persistencia de inputs ----------
  $('resetlv').onchange = () => chrome.storage.local.set({ resetLv: +$('resetlv').value || 0 });
  $('pts').onchange = () => chrome.storage.local.set({ statPts: $('pts').value });
  $('chatx').onchange = $('chaty').onchange = () => chrome.storage.local.set({
    chatX: $('chatx').value === '' ? null : +$('chatx').value,
    chatY: $('chaty').value === '' ? null : +$('chaty').value
  });
  $('watchlist').oninput = () => chrome.storage.local.set({ watchlist: $('watchlist').value });
  $('radar-dist').oninput = () => chrome.storage.local.set({ radarMinDist: +$('radar-dist').value || 0 });
  $('radar-ttl').oninput = () => chrome.storage.local.set({ radarTTL: Math.max(3, +$('radar-ttl').value || 15) });
  $('me-x').oninput = () => chrome.storage.local.set({ radarMeX: $('me-x').value === '' ? 226 : +$('me-x').value });
  $('me-y').oninput = () => chrome.storage.local.set({ radarMeY: $('me-y').value === '' ? 236 : +$('me-y').value });

  // ---------- mensajería ----------
  // bg: background.js (keys / chat / pick / start / stop) · toGame: content.js de la pestaña con datos
  const bg = async (type, extra) => {
    const tab = (await chrome.tabs.query({ url: GAME }))[0];
    if (!tab?.id) return console.warn('[panel] no encontré la pestaña del juego');
    chrome.runtime.sendMessage({ target: 'bg', type, tabId: tab.id, ...extra }).catch(() => { });
  };
  let gameTabId = null;
  const toGame = (msg) => { if (gameTabId != null) chrome.tabs.sendMessage(gameTabId, { target: 'content', ...msg }).catch(() => { }); };

  // ---------- mouse hold ----------
  const requestPick = async (kind) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) chrome.runtime.sendMessage({ target: 'bg', type: 'pick', tabId: tab.id, kind });
  };
  $('pick-hold').onclick = () => requestPick('hold');
  $('chat-pick').onclick = () => requestPick('chat');

  $('go').onclick = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    const r = +$('rep').value || 0;
    const cfg = {
      repeat: r > 0 ? Math.max(50, r) : 0,
      button: $('btn').value,
      x: $('x').value === '' ? null : +$('x').value,
      y: $('y').value === '' ? null : +$('y').value
    };
    await chrome.storage.local.set(cfg);
    chrome.runtime.sendMessage({ target: 'bg', type: 'start', tabId: tab.id, ...cfg });
  };
  $('stop').onclick = $('f-stop').onclick = () => chrome.runtime.sendMessage({ target: 'bg', type: 'stop' });

  // ---------- chat / atajos / puntos ----------
  const doChat = async () => {
    chrome.storage.local.set({ chatMsg: $('chat').value });
    bg('chat', { text: $('chat').value.trim() });
  };
  $('chat-send').onclick = doChat;
  $('chat').addEventListener('keydown', (e) => { if (e.key === 'Enter') doChat(); });

  ['str', 'agi', 'vit', 'ene', 'cmd'].forEach((s) => {
    const b = document.createElement('button');
    b.textContent = s.toUpperCase();
    b.title = '/add ' + s + ' (usa la cantidad del cuadro)';
    b.onclick = () => { const n = parseInt($('pts').value, 10); bg('chat', { text: '/add ' + s + (n > 0 ? ' ' + n : '') }); };
    $('stat-grid').appendChild(b);
  });

  const renderQuick = (str) => {
    $('qgrid').replaceChildren(...str.split(',').map((s) => s.trim()).filter(Boolean).map((item) => {
      const i = item.lastIndexOf(':');
      const b = document.createElement('button');
      b.textContent = i > 0 ? item.slice(0, i).trim() : item;
      b.title = 'Tecla: ' + (i > 0 ? item.slice(i + 1).trim() : item);
      b.onclick = () => bg('keys', { seq: [i > 0 ? item.slice(i + 1).trim() : item] });
      return b;
    }), Object.assign(document.createElement('button'), {
      className: 'esc', textContent: 'Esc', title: 'Cerrar ventanas del juego',
      onclick: () => bg('keys', { seq: ['Escape'] })
    }));
  };
  renderQuick($('quick-cfg').value);
  $('quick-cfg').onchange = () => {
    const v = $('quick-cfg').value.trim() || DEFAULT_QUICK;
    $('quick-cfg').value = v;
    chrome.storage.local.set({ quick: v });
    renderQuick(v);
  };

  // ---------- ESP / Auto ----------
  const splitNames = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
  $('esp-toggle').onclick = async () => chrome.storage.local.set({ espEnabled: !(await chrome.storage.local.get('espEnabled')).espEnabled });
  $('esp-save').onclick = async () => {
    const { espCfg } = await chrome.storage.local.get('espCfg');
    chrome.storage.local.set({ espCfg: Object.assign({}, espCfg || {}, { maxDist: +$('esp-max-dist').value || 0, names: splitNames($('esp-names').value), showNames: splitNames($('esp-black').value) }) });
  };
  $('auto-toggle').onclick = async () => chrome.storage.local.set({ autoEnabled: !(await chrome.storage.local.get('autoEnabled')).autoEnabled });
  $('auto-save').onclick = async () => {
    const { autoCfg } = await chrome.storage.local.get('autoCfg');
    chrome.storage.local.set({
      autoCfg: Object.assign({}, autoCfg || {}, {
        user: $('auto-user').value, pass: $('auto-pass').value, charName: $('auto-char').value,
        icarusLv: { gm: +$('auto-lv-gm').value || 113, _default: +$('auto-lv-def').value || 170 }
      })
    });
  };

  // ---------- radar: estado, ubicaciones guardadas, registro ----------
  let lastSt = null, savedLocs = Array.isArray(c.savedLocs) ? c.savedLocs : [];
  let mapId = null, terrain = null, heatMap = null, heatImg = null, heatAt = 0, heatSpots = [];
  let lastScan = 0, busy = false, tick = 0;
  let prevHits = new Set(), prevWalking = false, prevMapSeen = null;
  const evs = [];

  const ev = (txt, cls) => {
    evs.unshift({ t: new Date().toTimeString().slice(0, 5), txt, cls });
    if (evs.length > 30) evs.pop();
    $('evlog').replaceChildren(...evs.slice(0, 4).map((e) => {
      const d = document.createElement('div');
      const s = document.createElement('span');
      s.className = e.cls; s.textContent = e.t;
      d.append(s, ' ' + e.txt);
      return d;
    }));
  };

  // chips bajo el mapa: spots calientes (dorado) + ubicaciones guardadas (verde / punteado si es otro mapa) + guardar aquí
  const renderChips = () => {
    const chips = heatSpots.map((s, k) => {
      const b = document.createElement('button');
      b.className = 'chp';
      b.textContent = (k + 1) + ' · ' + s.n;
      b.title = 'Spot (' + s.x + ', ' + s.y + ') · clic = ir';
      b.onclick = () => toGame({ type: 'goto', x: s.x, y: s.y });
      return b;
    });
    savedLocs.forEach((l, i) => {
      const b = document.createElement('button');
      const other = lastSt?.ok && lastSt.map != null && l.map != null && l.map !== lastSt.map;
      b.className = 'chp sv' + (other ? ' other' : '');
      b.textContent = l.name + (l.map != null ? ' · m' + l.map : '');
      b.title = (other ? '⚠️ Otro mapa (m' + l.map + ') · ' : '') + '(' + l.x + ', ' + l.y + ') · clic = ir · clic derecho = borrar';
      b.onclick = () => toGame({ type: 'goto', x: l.x, y: l.y });
      b.oncontextmenu = (e) => { e.preventDefault(); savedLocs.splice(i, 1); chrome.storage.local.set({ savedLocs }); renderChips(); };
      chips.push(b);
    });
    const add = document.createElement('button');
    add.className = 'chp add';
    add.textContent = '+ guardar aquí';
    add.title = 'Clic: guarda tu posición · Shift+clic: con nombre';
    add.onclick = (e) => {
      if (!lastSt?.ok) { $('hud').textContent = 'Sin datos del juego: camina un poco antes de guardar.'; return; }
      const { x, y } = lastSt.me;
      const nm = e.shiftKey ? prompt('Nombre de la ubicación:', 'Spot ' + (savedLocs.length + 1)) : '';
      if (nm === null) return;
      savedLocs.push({ name: (nm || '').trim() || 'Pos (' + x + ', ' + y + ')', x, y, map: lastSt.map });
      if (savedLocs.length > 100) savedLocs.shift();
      chrome.storage.local.set({ savedLocs });
      renderChips();
    };
    chips.push(add);
    $('chips').replaceChildren(...chips);
  };
  renderChips();

  $('goto-btn').onclick = () => {
    if ($('goto-x').value === '' || $('goto-y').value === '') return;
    toGame({ type: 'goto', x: +$('goto-x').value, y: +$('goto-y').value });
  };
  $('map').onclick = (e) => {
    const r = e.target.getBoundingClientRect();
    toGame({ type: 'goto', x: 255 - Math.floor((e.clientX - r.left) * 256 / r.width), y: Math.floor((e.clientY - r.top) * 256 / r.height) }); // canvas espejado por CSS
  };
  $('map').oncontextmenu = (e) => { e.preventDefault(); toGame({ type: 'stopwalk' }); };
  $('walk-stop').onclick = () => toGame({ type: 'stopwalk' });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') toGame({ type: 'stopwalk' }); });

  // ---------- estado barato (hold / esp / auto / chat): se repinta en cada tick y al cambiar storage ----------
  const paintState = async () => {
    const [{ run }, l] = await Promise.all([
      chrome.storage.session.get('run'),
      chrome.storage.local.get(['espEnabled', 'autoEnabled', 'autoState', 'espCfg'])
    ]);
    $('led-hold').className = 'led' + (run ? ' on' : '');
    $('tv-hold').textContent = run ? 'Mantiene ' + run.button.toUpperCase() : 'Suelto';
    $('ts-hold').textContent = run ? 'tab ' + run.tabId + ' · (' + Math.round(run.x) + ', ' + Math.round(run.y) + ')' : $('btn').selectedOptions[0].text.toLowerCase() + ' · ' + ($('rep').value || 0) + 'ms';

    const zone = $('chatx').value !== '' && $('chaty').value !== '';
    $('led-chat').className = 'led' + (zone ? ' on' : '');
    $('ts-chat').textContent = zone ? 'zona ' + $('chatx').value + ',' + $('chaty').value : 'sin zona';

    $('led-esp').className = 'led' + (l.espEnabled ? ' on' : '');
    $('tv-esp').textContent = l.espEnabled ? 'On' : 'Off';
    $('ts-esp').textContent = l.espCfg?.maxDist ? '≤ ' + l.espCfg.maxDist + ' tiles' : 'sin límite';
    $('esp-toggle').textContent = 'ESP: ' + (l.espEnabled ? 'ON' : 'OFF');
    $('esp-toggle').className = 'b grow ' + (l.espEnabled ? 'tg-on' : 'tg-off');

    const a = l.autoState;
    $('led-auto').className = 'led' + (l.autoEnabled ? ' on' : '');
    $('tv-auto').textContent = l.autoEnabled ? 'On' : 'Off';
    $('ts-auto').textContent = a ? 'fase ' + a.phase : '—';
    $('auto-toggle').textContent = 'AUTO: ' + (l.autoEnabled ? 'ON' : 'OFF');
    $('auto-toggle').className = 'b grow ' + (l.autoEnabled ? 'tg-on' : 'tg-off');
    if (a) $('auto-status').textContent = `fase=${a.phase} · char=${a.charLevel} · lv=${a.lv} · map=${a.map} · ${a.cls}`;
  };

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch.button) $('btn').value = ch.button.newValue || 'right';
    if (ch.x) $('x').value = ch.x.newValue ?? '';
    if (ch.y) $('y').value = ch.y.newValue ?? '';
    if (ch.repeat) $('rep').value = ch.repeat.newValue ?? 300;
    if (ch.quick) { $('quick-cfg').value = ch.quick.newValue || DEFAULT_QUICK; renderQuick($('quick-cfg').value); }
    if (ch.chatMsg) $('chat').value = ch.chatMsg.newValue ?? '';
    if (ch.statPts) $('pts').value = ch.statPts.newValue ?? '';
    if (ch.chatX) $('chatx').value = ch.chatX.newValue ?? '';
    if (ch.chatY) $('chaty').value = ch.chatY.newValue ?? '';
    if (ch.espEnabled || ch.autoEnabled || ch.espCfg || ch.chatX || ch.chatY) paintState();
  });

  // ---------- loop único: 500 ms estado barato · 1 s radar ----------
  setInterval(async () => {
    tick++;
    paintState();
    if (tick % 2 || busy) return;
    busy = true;
    try {
      const ask = async (id) => { try { return await chrome.tabs.sendMessage(id, { target: 'content', type: 'getState' }); } catch (_) { return null; } };
      let st = gameTabId != null ? await ask(gameTabId) : null;
      if (!st?.ok) {
        gameTabId = null;
        if (Date.now() - lastScan > 3000) {
          lastScan = Date.now();
          const tabs = await chrome.tabs.query({ url: GAME });
          const res = await Promise.all(tabs.filter((t) => t.id).map(async (t) => ({ id: t.id, s: await ask(t.id) })));
          const best = res.filter((r) => r.s?.ok).sort((a, b) => b.s.lastData - a.s.lastData)[0];
          if (best) { gameTabId = best.id; st = best.s; }
        }
      }

      const g = $('map').getContext('2d');
      if (!st?.ok) {
        lastSt = null;
        $('hdr').textContent = 'sin datos';
        $('hud').textContent = 'Abre la pestaña del juego… camina un poco.';
        $('hud').classList.remove('err');
        $('cals').replaceChildren();
        $('pl-count').textContent = '0 visibles';
        $('radar-container').innerHTML = '<div class="empty">Sin datos aún.</div>';
        $('led-radar').className = 'led';
        $('tv-radar').textContent = 'Sin datos';
        $('ts-radar').textContent = '—';
        return;
      }

      lastSt = st;
      if (st.map !== prevMapSeen) { if (prevMapSeen != null) ev('cambio a mapa m' + st.map, 'warn'); prevMapSeen = st.map; renderChips(); }

      const watch = (c => c.split(',').map((n) => n.trim().toLowerCase()).filter(Boolean))($('watchlist').value || '');
      const minDist = +$('radar-dist').value || 0;
      const ttl = Math.max(3, +$('radar-ttl').value || 15);
      const lista = st.players.sort((a, b) => a.dist - b.dist);
      const hits = lista.filter((p) => watch.includes(p.n.toLowerCase()) && p.dist >= minDist);

      // terreno del mapa actual (guardado en storage como base64 de 256x256)
      if (st.map != null && (st.map !== mapId || !terrain)) {
        mapId = st.map;
        const b64 = (await chrome.storage.local.get('map:' + mapId))['map:' + mapId];
        terrain = null;
        if (b64) {
          const bin = atob(b64), img = new ImageData(256, 256);
          const COL = { 0: [22, 27, 34], 1: [35, 134, 54], 4: [1, 4, 9], 5: [1, 40, 15], 8: [1, 4, 9], 16: [31, 111, 235] };
          for (let i = 0; i < 65536; i++) {
            const k = COL[bin.charCodeAt(i)] || [110, 64, 201];
            img.data.set([k[0], k[1], k[2], 255], i * 4);
          }
          terrain = img;
        }
      }

      // heatmap de mobs (recarga cada 10 s) + spots calientes (bloques 8x8, los 6 más densos, separados >10 tiles)
      if (st.map != null && (st.map !== heatMap || Date.now() - heatAt > 10000)) {
        heatAt = Date.now();
        const raw = (await chrome.storage.local.get('heat:' + st.map))['heat:' + st.map];
        heatMap = st.map; heatImg = null; heatSpots = [];
        if (raw) {
          const o = JSON.parse(raw), dec = (b) => Uint8Array.from(atob(b), (ch) => ch.charCodeAt(0));
          const h = dec(o.h), ix = dec(o.i), img = new ImageData(256, 256);
          const sum = new Float32Array(1024), best = new Int32Array(1024).fill(-1), nm = Array.from({ length: 1024 }, () => ({}));
          for (let k = 0; k < 65536; k++) {
            if (!h[k]) continue;
            img.data.set([240, 180, 41, Math.min(255, 70 + h[k] * 12)], k * 4);
            const bk = (k >> 8 >> 3) * 32 + ((k & 255) >> 3);
            sum[bk] += h[k];
            nm[bk][ix[k]] = (nm[bk][ix[k]] || 0) + h[k];
            if (best[bk] < 0 || h[k] > h[best[bk]]) best[bk] = k; // destino = tile donde más se vio un mob (seguro caminable)
          }
          for (const bk of [...sum.keys()].sort((a, b) => sum[b] - sum[a])) {
            if (sum[bk] < 6 || heatSpots.length >= 6) break;
            const x = best[bk] & 255, y = best[bk] >> 8;
            if (heatSpots.some((s) => Math.hypot(s.x - x, s.y - y) < 10)) continue;
            heatSpots.push({ x, y, n: o.n[Object.entries(nm[bk]).sort((a, b) => b[1] - a[1])[0][0]] });
          }
          const hc = document.createElement('canvas'); hc.width = hc.height = 256;
          hc.getContext('2d').putImageData(img, 0, 0);
          heatImg = hc;
        }
        renderChips();
      }

      // dibujo del mapa (el canvas está volteado por CSS: el texto se contra-espeja)
      g.clearRect(0, 0, 256, 256);
      if (terrain) g.putImageData(terrain, 0, 0);
      if (heatImg) g.drawImage(heatImg, 0, 0);
      for (const [, x, y] of st.mobs || []) { g.fillStyle = '#a371f7'; g.fillRect(x - 1, y - 1, 2, 2); }
      heatSpots.forEach((s, k) => {
        g.strokeStyle = '#f0b429'; g.lineWidth = 1; g.beginPath(); g.arc(s.x + .5, s.y + .5, 5, 0, 7); g.stroke();
        g.save(); g.translate(s.x + 7, s.y - 5); g.scale(-1, 1); g.fillStyle = '#f0b429'; g.font = '700 9px monospace'; g.fillText(k + 1, 0, 0); g.restore();
      });
      for (const p of lista) {
        const w = watch.includes(p.n.toLowerCase());
        g.fillStyle = w ? '#f85149' : '#f0b429';
        g.fillRect(p.x - 1, p.y - 1, 3, 3);
        if (w) { g.strokeStyle = '#f85149'; g.strokeRect(p.x - 4, p.y - 4, 9, 9); }
      }
      if (st.route?.length) {
        const end = st.route[st.route.length - 1];
        g.save();
        g.strokeStyle = '#58a6ff'; g.lineWidth = 1.2; g.setLineDash([3, 2]);
        g.beginPath(); g.moveTo(st.me.x + .5, st.me.y + .5);
        for (const [x, y] of st.route.slice(st.routeIdx)) g.lineTo(x + .5, y + .5);
        g.stroke();
        g.restore();
        g.strokeStyle = '#3fb950'; g.strokeRect(end[0] - 2, end[1] - 2, 5, 5);
      }
      g.strokeStyle = '#58a6ff';
      g.strokeRect(st.me.x - 2, st.me.y - 2, 5, 5);

      // alertas anotadas directamente sobre el mapa (HTML encima del canvas; no se espejan)
      $('cals').replaceChildren(...hits.slice(0, 4).map((p) => {
        const d = document.createElement('div');
        const lx = (255 - p.x) / 256 * 100;
        d.className = 'cal';
        d.textContent = p.n + ' · ' + p.dist + 't';
        d.style.top = 'calc(' + (p.y / 256 * 100) + '% - 22px)';
        if (lx > 60) { d.style.right = (100 - lx) + '%'; } else { d.style.left = lx + '%'; }
        return d;
      }));

      // registro de eventos: vigilados que entran/salen y autowalk
      const nowHits = new Set(hits.map((p) => p.n));
      hits.forEach((p) => { if (!prevHits.has(p.n)) ev(p.n + ' entró a ' + p.dist + 't', 'bad'); });
      prevHits.forEach((n) => { if (!nowHits.has(n)) ev(n + ' salió', 'warn'); });
      prevHits = nowHits;
      if (st.walking && !prevWalking) ev('autowalk' + (st.route?.length ? ' → (' + st.route[st.route.length - 1].join(',') + ')' : ' iniciado'), 'ok');
      if (!st.walking && prevWalking) ev('autowalk terminó', 'warn');
      prevWalking = !!st.walking;

      // cabecera, hud y tile de radar
      $('hdr').textContent = (st.map != null ? 'm' + st.map + ' · ' : '') + 'pos (' + st.me.x + ', ' + st.me.y + ') ' + (st.me.auto ? 'auto' : 'manual');
      $('hud').textContent = [
        st.walking && '🚶 caminando',
        st.route?.length ? 'ruta ' + (st.route.length - st.routeIdx) + 't' : st.walkMsg,
        st.mobs?.length && st.mobs.length + ' mobs'
      ].filter(Boolean).join(' · ') || 'listo';
      $('hud').classList.remove('err');
      $('led-radar').className = 'led ' + (hits.length ? 'al' : 'on');
      $('tv-radar').textContent = hits.length + ' vigilado' + (hits.length === 1 ? '' : 's');
      $('ts-radar').textContent = 'alerta ' + minDist + 't · ttl ' + ttl + 's';

      // tabla de jugadores
      $('pl-count').textContent = lista.length + ' visible' + (lista.length === 1 ? '' : 's');
      if (!lista.length) { $('radar-container').innerHTML = '<div class="empty">Sin jugadores.</div>'; return; }
      const table = document.createElement('table');
      table.innerHTML = '<thead><tr><th>Jugador</th><th>Dist</th><th>Coords</th><th>Visto</th></tr></thead>';
      const tbody = document.createElement('tbody');
      for (const p of lista) {
        const tr = document.createElement('tr');
        const cls = [];
        if (watch.includes(p.n.toLowerCase()) && p.dist >= minDist) cls.push('interest');
        if (p.age > ttl * 500) cls.push('stale'); // más de la mitad del TTL sin verse
        tr.className = cls.join(' ');
        tr.title = 'Clic: ir · Shift+clic: seguir';
        tr.onclick = (e) => toGame(e.shiftKey ? { type: 'follow', name: p.n } : { type: 'goto', x: p.x, y: p.y });
        // textContent: los nombres vienen del juego, nunca como HTML
        for (const v of [p.n, p.dist + 't', '(' + p.x + ', ' + p.y + ')', Math.round(p.age / 1000) + 's']) {
          const td = document.createElement('td');
          td.textContent = v;
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      $('radar-container').replaceChildren(table);
    } catch (e) {
      $('hud').textContent = 'Error: ' + e.message;
      $('hud').classList.add('err');
      console.error(e);
    } finally {
      busy = false;
    }
  }, 500);
})();