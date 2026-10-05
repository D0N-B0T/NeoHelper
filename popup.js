// popup.js
import {
  $, GAME_URL, findGameTab, sendToGame,
  decodeTerrain, decodeHeat, drawMap,
  renderPlayersTable, renderChips, createEventLog,
  loadSavedLocs, saveSavedLocs, splitNames
} from './ui/shared.js';

(async () => {
  // ---------- carga inicial ----------
  const c = await chrome.storage.local.get([
    'button', 'x', 'y', 'repeat', 'chatMsg', 'statPts', 'chatX', 'chatY', 'resetLv',
    'watchlist', 'radarMinDist', 'radarTTL', 'radarMeX', 'radarMeY', 'savedLocs', 'uiTile',
    'espCfg', 'autoCfg', 'resetBase'
  ]);

  $('btn').value = c.button || 'right';
  $('x').value = c.x ?? '';
  $('y').value = c.y ?? '';
  $('rep').value = c.repeat ?? 300;
  $('resetlv').value = c.resetLv ?? 400;
  if (c.chatMsg) $('chat').value = c.chatMsg;
  if (c.chatX != null) $('chatx').value = c.chatX;
  if (c.chatY != null) $('chaty').value = c.chatY;
  if (c.statPts != null) $('pts').value = c.statPts;
  if (c.watchlist) $('watchlist').value = c.watchlist;
  if (c.radarMinDist != null) $('radar-dist').value = c.radarMinDist;
  if (c.radarTTL != null) $('radar-ttl').value = c.radarTTL;
  if (c.radarMeX != null) $('me-x').value = c.radarMeX;
  if (c.radarMeY != null) $('me-y').value = c.radarMeY;
  if (c.espCfg) {
    $('esp-max-dist').value = c.espCfg.maxDist ?? 0;
    $('esp-names').value = (c.espCfg.whitelist || []).join(', ');
    $('esp-black').value = (c.espCfg.blacklist || []).join(', ');
  }
  if (c.autoCfg) {
    $('auto-user').value = c.autoCfg.user || '';
    $('auto-pass').value = c.autoCfg.pass || '';
    $('auto-char').value = c.autoCfg.charName || '';
    $('auto-lv-gm').value = c.autoCfg.icarusLv?.gm ?? 113;
    $('auto-lv-def').value = c.autoCfg.icarusLv?._default ?? 170;
  }
  if (c.resetBase != null) $('reset-base').value = c.resetBase;

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
  $('reset-base').onchange = () => chrome.storage.local.set({ resetBase: +$('reset-base').value || 0 });
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

  // ---------- mensajería al background ----------
  const bg = async (type, extra) => {
    const tabs = await chrome.tabs.query({ url: GAME_URL });
    const tab = tabs[0];
    if (!tab?.id) return console.warn('[panel] no encontré la pestaña del juego');
    chrome.runtime.sendMessage({ target: 'bg', type, tabId: tab.id, ...extra }).catch(() => { });
  };

  // ---------- pick ----------
  const requestPick = async (kind) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) chrome.runtime.sendMessage({ target: 'bg', type: 'pick', tabId: tab.id, kind });
  };
  $('pick-hold').onclick = () => requestPick('hold');
  $('chat-pick').onclick = () => requestPick('chat');

  // ---------- hold ----------
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

  // ---------- chat ----------
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
    b.onclick = () => {
      const n = parseInt($('pts').value, 10);
      bg('chat', { text: '/add ' + s + (n > 0 ? ' ' + n : '') });
    };
    $('stat-grid').appendChild(b);
  });

  // ---------- ESP / Auto ----------
  $('esp-toggle').onclick = async () =>
    chrome.storage.local.set({ espEnabled: !(await chrome.storage.local.get('espEnabled')).espEnabled });
  $('esp-save').onclick = async () => {
    const { espCfg } = await chrome.storage.local.get('espCfg');
    chrome.storage.local.set({
      espCfg: Object.assign({}, espCfg || {}, {
        maxDist: +$('esp-max-dist').value || 0,
        whitelist: splitNames($('esp-names').value),
        blacklist: splitNames($('esp-black').value)
      })
    });
  };
  $('auto-toggle').onclick = async () =>
    chrome.storage.local.set({ autoEnabled: !(await chrome.storage.local.get('autoEnabled')).autoEnabled });
  $('auto-save').onclick = async () => {
    const { autoCfg } = await chrome.storage.local.get('autoCfg');
    chrome.storage.local.set({
      autoCfg: Object.assign({}, autoCfg || {}, {
        user: $('auto-user').value, pass: $('auto-pass').value, charName: $('auto-char').value,
        icarusLv: { gm: +$('auto-lv-gm').value || 113, _default: +$('auto-lv-def').value || 170 }
      })
    });
  };
  $('ranking-btn').onclick = () => bg('chat', { text: '/ranking' });

  // ---------- mapa y ubicaciones ----------
  let lastSt = null, savedLocs = await loadSavedLocs();
  let mapId = null, terrain = null, heatMap = null, heatImg = null, heatAt = 0, heatSpots = [];
  let busy = false, tick = 0;
  let prevHits = new Set(), prevWalking = false, prevMapSeen = null;

  const ev = createEventLog($('evlog'));

  const rerenderChips = () => renderChips($('chips'), {
    heatSpots,
    savedLocs,
    currentMap: lastSt?.map,
    onGo: (x, y) => sendToGame({ type: 'goto', x, y }),
    onDeleteSaved: (i) => {
      savedLocs.splice(i, 1);
      saveSavedLocs(savedLocs);
      rerenderChips();
    },
    onSave: async (withName) => {
      if (!lastSt?.ok) { $('hud').textContent = 'Sin datos del juego.'; return; }
      const { x, y } = lastSt.me;
      const nm = withName ? prompt('Nombre:', 'Spot ' + (savedLocs.length + 1)) : '';
      if (nm === null) return;
      savedLocs.push({ name: (nm || '').trim() || `Pos (${x}, ${y})`, x, y, map: lastSt.map });
      if (savedLocs.length > 100) savedLocs.shift();
      saveSavedLocs(savedLocs);
      rerenderChips();
    }
  });

  $('goto-btn').onclick = () => {
    if ($('goto-x').value === '' || $('goto-y').value === '') return;
    sendToGame({ type: 'goto', x: +$('goto-x').value, y: +$('goto-y').value });
  };
  $('map').onclick = (e) => {
    const r = e.target.getBoundingClientRect();
    sendToGame({
      type: 'goto',
      x: 255 - Math.floor((e.clientX - r.left) * 256 / r.width),
      y: Math.floor((e.clientY - r.top) * 256 / r.height)
    });
  };
  $('map').oncontextmenu = (e) => { e.preventDefault(); sendToGame({ type: 'stopwalk' }); };
  $('walk-stop').onclick = () => sendToGame({ type: 'stopwalk' });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') sendToGame({ type: 'stopwalk' }); });

  // ---------- paintState (leds, tiles) ----------
  const paintState = async () => {
    const [{ run }, l] = await Promise.all([
      chrome.storage.session.get('run'),
      chrome.storage.local.get(['espEnabled', 'autoEnabled', 'autoState', 'espCfg'])
    ]);
    $('led-hold').className = 'led' + (run ? ' on' : '');
    $('tv-hold').textContent = run ? 'Mantiene ' + run.button.toUpperCase() : 'Suelto';
    $('ts-hold').textContent = run
      ? `tab ${run.tabId} · (${Math.round(run.x)}, ${Math.round(run.y)})`
      : ($('btn').selectedOptions[0].text.toLowerCase() + ' · ' + ($('rep').value || 0) + 'ms');

    const zone = $('chatx').value !== '' && $('chaty').value !== '';
    $('led-chat').className = 'led' + (zone ? ' on' : '');
    $('ts-chat').textContent = zone ? `zona ${$('chatx').value},${$('chaty').value}` : 'sin zona';

    $('led-esp').className = 'led' + (l.espEnabled ? ' on' : '');
    $('tv-esp').textContent = l.espEnabled ? 'On' : 'Off';
    $('ts-esp').textContent = l.espCfg?.maxDist ? `≤ ${l.espCfg.maxDist} tiles` : 'sin límite';
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

  // ---------- loop principal ----------
  setInterval(async () => {
    tick++;
    paintState();
    if (tick % 2 || busy) return;
    busy = true;
    try {
      const found = await findGameTab();
      const st = found?.st;

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
      if (st.map !== prevMapSeen) {
        if (prevMapSeen != null) ev('cambio a mapa m' + st.map, 'warn');
        prevMapSeen = st.map;
        rerenderChips();
      }

      const watch = splitNames($('watchlist').value).map(s => s.toLowerCase());
      const minDist = +$('radar-dist').value || 0;
      const ttl = Math.max(3, +$('radar-ttl').value || 15);
      const lista = st.players.sort((a, b) => a.dist - b.dist);
      const hits = lista.filter((p) => watch.includes(p.n.toLowerCase()) && p.dist >= minDist);

      // terreno
      if (st.map != null && (st.map !== mapId || !terrain)) {
        mapId = st.map;
        const b64 = (await chrome.storage.local.get('map:' + mapId))['map:' + mapId];
        terrain = decodeTerrain(b64);
      }

      // heatmap
      if (st.map != null && (st.map !== heatMap || Date.now() - heatAt > 10000)) {
        heatAt = Date.now();
        const raw = (await chrome.storage.local.get('heat:' + st.map))['heat:' + st.map];
        heatMap = st.map;
        const decoded = decodeHeat(raw);
        heatImg = decoded.img;
        heatSpots = decoded.spots;
        rerenderChips();
      }

      // dibujo
      drawMap($('map'), {
        terrain, heatImg,
        mobs: st.mobs, players: lista, watch,
        route: st.route, routeIdx: st.routeIdx,
        me: st.me, heatSpots
      });

      // etiquetas de alerta sobre el mapa
      $('cals').replaceChildren(...hits.slice(0, 4).map((p) => {
        const d = document.createElement('div');
        const lx = (255 - p.x) / 256 * 100;
        d.className = 'cal';
        d.textContent = p.n + ' · ' + p.dist + 't';
        d.style.top = `calc(${p.y / 256 * 100}% - 22px)`;
        if (lx > 60) d.style.right = (100 - lx) + '%';
        else d.style.left = lx + '%';
        return d;
      }));

      // log
      const nowHits = new Set(hits.map((p) => p.n));
      hits.forEach((p) => { if (!prevHits.has(p.n)) ev(p.n + ' entró a ' + p.dist + 't', 'bad'); });
      prevHits.forEach((n) => { if (!nowHits.has(n)) ev(n + ' salió', 'warn'); });
      prevHits = nowHits;
      if (st.walking && !prevWalking) ev('autowalk' + (st.route?.length ? ' → (' + st.route[st.route.length - 1].join(',') + ')' : ' iniciado'), 'ok');
      if (!st.walking && prevWalking) ev('autowalk terminó', 'warn');
      prevWalking = !!st.walking;

      // cabecera / hud / radar tile
      $('hdr').textContent = (st.map != null ? 'm' + st.map + ' · ' : '') + 'pos (' + st.me.x + ', ' + st.me.y + ') ' + (st.me.auto ? 'auto' : 'manual');
      $('hud').textContent = [
        st.walking && '🚶 caminando',
        st.route?.length ? 'ruta ' + (st.route.length - st.routeIdx) + 't' : st.walkMsg,
        st.mobs?.length && st.mobs.length + ' mobs'
      ].filter(Boolean).join(' · ') || 'listo';
      $('hud').classList.remove('err');
      $('led-radar').className = 'led ' + (hits.length ? 'al' : 'on');
      $('tv-radar').textContent = hits.length + ' vigilado' + (hits.length === 1 ? '' : 's');
      $('ts-radar').textContent = `alerta ${minDist}t · ttl ${ttl}s`;

      // tabla
      $('pl-count').textContent = lista.length + ' visible' + (lista.length === 1 ? '' : 's');
      renderPlayersTable($('radar-container'), lista, {
        watch, minDist, ttl,
        onGo: (x, y) => sendToGame({ type: 'goto', x, y }),
        onFollow: (n) => sendToGame({ type: 'follow', name: n })
      });
    } catch (e) {
      $('hud').textContent = 'Error: ' + e.message;
      $('hud').classList.add('err');
      console.error(e);
    } finally {
      busy = false;
    }
  }, 500);
})();