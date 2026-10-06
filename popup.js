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
    'espCfg', 'autoCfg', 'resetBase', 'huntCfg', 'simGridStep'
  ]);
  // ---------- rutas ----------
  let routes = [];
  let activeRouteId = null;

  const GAME_MAPS = [
    [0, 'Lorencia'], [1, 'Dungeon'], [2, 'Devias'], [3, 'Noria'],
    [4, 'LostTower'], [5, 'Exile'], [6, 'Arena'], [7, 'Atlans'],
    [8, 'Tarkan'], [9, 'Devil Square'], [10, 'Icarus'],
    [11, 'Blood Castle 1'], [12, 'Blood Castle 2'], [13, 'Blood Castle 3'],
    [24, 'Kalima 1'], [25, 'Kalima 2'], [26, 'Kalima 3'],
    [33, 'Aida'], [34, 'Crywolf Fortress'], [37, 'Kantru 1'],
    [38, 'Kantru 2'], [39, 'Kantru 3'], [56, 'Swamp of Calmness'],
    [57, 'Raklion'], [63, 'Vulcanus'],
  ];

  // Variantes /move por mapa (mismo array que content/cfg.js DEFAULTS.mapVariants).
  // Devias 1-4, Dungeon 1-3, etc. son sub-mapas con el MISMO mapIndex pero
  // distinto comando, asi que hay que elegir la variante por paso.
  const VARIANTS_DEFAULT = [
    [0, ['/move lorencia']],
    [2, ['/move devias', '/move devias2', '/move devias3', '/move devias4']],
    [1, ['/move dungeon', '/move dungeon2', '/move dungeon3']],
    [6, ['/move arena', '/move arena2', '/move arena3', '/move arena4']],
    [4, ['/move losttower', '/move losttower2', '/move losttower3', '/move losttower4', '/move losttower5', '/move losttower6', '/move losttower7']],
    [7, ['/move atlans', '/move atlans2', '/move atlans3']],
    [8, ['/move tarkan', '/move tarkan2']],
    [10, ['/move icarus']],
  ];
  let MAP_VARIANTS = VARIANTS_DEFAULT;
  const cfgStored = await chrome.storage.local.get('cfg');
  if (Array.isArray(cfgStored?.cfg?.mapVariants) && cfgStored.cfg.mapVariants.length) {
    MAP_VARIANTS = cfgStored.cfg.mapVariants;
  }
  const variantsFor = (mapId) => {
    const row = MAP_VARIANTS.find(([id]) => +id === +mapId);
    return row ? row[1] : [];
  };
  // Antes todos los pasos de Devias apuntaban a /move devias4 (bug de claves
  // repetidas en moveCommands). Si un paso guardado conserva esa marca erronea
  // (lastMoveCmd === la ultima variante), lo devolvemos a la primera.
  const fixLegacySteps = () => {
    for (const r of routes) {
      for (const s of r.steps || []) {
        const list = variantsFor(s.map);
        if (list.length < 2) continue;
        if (s.cmd && list.includes(s.cmd)) continue;
        if (!s.cmd && s.lastMoveCmd === list[list.length - 1]) s.cmd = list[0];
      }
    }
  };

  const renderRoutes = () => {
    const sel = $('route-active');
    sel.replaceChildren(...routes.map(r => {
      const o = document.createElement('option');
      o.value = r.id;
      o.textContent = r.name;
      return o;
    }));
    sel.value = activeRouteId;

    const active = routes.find(r => r.id === activeRouteId);
    $('route-name').value = active?.name || '';

    const list = $('route-steps');
    if (!active || !active.steps.length) {
      list.innerHTML = '<div class="empty">Sin pasos.</div>';
      return;
    }

    list.replaceChildren(...active.steps.map((s, i) => {
      const row = document.createElement('div');
      row.className = 'r';
      row.style.marginBottom = '4px';

      const lvInp = document.createElement('input');
      lvInp.type = 'number'; lvInp.value = s.lv;
      lvInp.style.width = '60px';
      lvInp.title = 'LV desde';
      lvInp.onchange = () => { s.lv = +lvInp.value || 0; saveRoute(active); };

      const mapSel = document.createElement('select');
      mapSel.className = 'grow';
      mapSel.replaceChildren(...GAME_MAPS.map(([id, name]) => {
        const o = document.createElement('option');
        o.value = id; o.textContent = name;
        return o;
      }));
      mapSel.value = s.map;

      // Selector de variante (/move devias, devias2, ...). Se repuebla al
      // cambiar la ciudad; si el paso no tiene variante, queda la primera.
      const varSel = document.createElement('select');
      varSel.className = 'grow';
      varSel.title = 'Sub-mapa (/move ...)';
      const fillVariants = () => {
        const list = variantsFor(s.map);
        varSel.replaceChildren(...list.map(c => {
          const o = document.createElement('option');
          o.value = c; o.textContent = c.replace('/move ', '');
          return o;
        }));
        varSel.disabled = list.length < 2;
        varSel.value = (s.cmd && list.includes(s.cmd)) ? s.cmd : list[0] || '';
        s.cmd = varSel.value || null;
      };
      fillVariants();
      varSel.onchange = () => { s.cmd = varSel.value || null; saveRoute(active); };
      mapSel.onchange = () => {
        s.map = +mapSel.value;
        s.cmd = null;              // ciudad nueva -> variante por defecto
        fillVariants();
        saveRoute(active);
      };

      const xInp = document.createElement('input');
      xInp.type = 'number'; xInp.value = s.spot.x; xInp.style.width = '52px';
      xInp.title = 'X';
      xInp.onchange = () => { s.spot.x = +xInp.value || 0; saveRoute(active); };

      const yInp = document.createElement('input');
      yInp.type = 'number'; yInp.value = s.spot.y; yInp.style.width = '52px';
      yInp.title = 'Y';
      yInp.onchange = () => { s.spot.y = +yInp.value || 0; saveRoute(active); };

      const useBtn = document.createElement('button');
      useBtn.className = 'b'; useBtn.textContent = '🎯';
      useBtn.title = 'Usar mi posición actual';
      useBtn.onclick = async () => {
        const st = lastSt;
        if (!st?.ok) return;
        s.map = st.map;
        s.spot.x = st.me.x;
        s.spot.y = st.me.y;
        const list = variantsFor(s.map);
        if (s.cmd && !list.includes(s.cmd)) s.cmd = null;
        saveRoute(active);
        renderRoutes();
      };

      const untilInp = document.createElement('input');
      untilInp.type = 'number'; untilInp.value = s.untilLv;
      untilInp.style.width = '60px';
      untilInp.title = 'Hasta LV';
      untilInp.onchange = () => { s.untilLv = +untilInp.value || 0; saveRoute(active); };

      const delBtn = document.createElement('button');
      delBtn.className = 'b stp2'; delBtn.textContent = '✕';
      delBtn.onclick = () => { active.steps.splice(i, 1); saveRoute(active); renderRoutes(); };

      row.append(lvInp, mapSel, varSel, xInp, yInp, useBtn, untilInp, delBtn);
      return row;
    }));
  };

  const saveRoute = (route) => {
    // Guardar en storage a través del content (routes.js)
    toContent({ type: 'route-save', route });
  };

  const toContent = async (msg) => {
    const found = await findGameTab();
    if (!found) {
      console.warn('[panel] no hay pestaña del juego (toContent)', msg.type);
      $('hunt-status').textContent = 'No hay pestaña del juego. Abre el juego y camina un poco.';
      return;
    }
    try {
      await chrome.tabs.sendMessage(found.id, { target: 'content', ...msg });
    } catch (e) {
      console.warn('[panel] no pude entregar', msg.type, '-', e?.message || e);
    }
  };
  // hunt config por defecto
  const HUNT_DEFAULTS = {
    map: 0,
    radius: 40,
    salt: 12,
    loot: true,
    enabled: {},   // { 'Golden Goblin': true, 'Golden Dragon': false, ... }
  };
  const huntCfg = Object.assign({}, HUNT_DEFAULTS, c.huntCfg || {});
  $('hunt-map').value = huntCfg.map;
  $('hunt-radius').value = huntCfg.radius;
  $('hunt-salt').value = huntCfg.salt;
  $('hunt-loot').value = huntCfg.loot ? '1' : '0';
  // Nombres exactos por mapa (los mismos que usa el módulo hunt.js)
  const GOLDENS_BY_MAP = {
    0: ['Golden Goblin', 'Golden Dragon'],           // Lorencia
    2: ['Golden Titan', 'Golden Dragon'],            // Devias
    3: ['Golden Goblin', 'Golden Dragon'],           // Noria
    7: ['Golden Lizard King'],                       // Atlans
    8: ['Golden Tantalos'],                          // Tarkan
  };
  $('btn').value = c.button || 'right';
  $('x').value = c.x ?? '';
  $('y').value = c.y ?? '';
  $('rep').value = c.repeat ?? 300;
  $('resetlv').value = c.resetLv ?? 400;
  if (c.chatMsg) $('chat').value = c.chatMsg;
  if (c.chatX != null) $('chatx').value = c.chatX;
  if (c.chatY != null) $('chaty').value = c.chatY;
  if (c.statPts != null) $('pts').value = c.statPts;
  if (c.simGridStep != null) $('sim-grid-step').value = +c.simGridStep || 12;
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
  $('hunt-map').onchange = () => {
    huntCfg.map = +$('hunt-map').value;
    chrome.storage.local.set({ huntCfg });
    renderHuntList();
  };
  $('hunt-radius').oninput = () => {
    huntCfg.radius = +$('hunt-radius').value || 40;
    chrome.storage.local.set({ huntCfg });
  };
  $('hunt-salt').oninput = () => {
    huntCfg.salt = Math.max(4, +$('hunt-salt').value || 12);
    chrome.storage.local.set({ huntCfg });
  };
  $('hunt-loot').onchange = () => {
    huntCfg.loot = $('hunt-loot').value === '1';
    chrome.storage.local.set({ huntCfg });
  };
  // ---------- rutas: handlers (antes estaban dentro de $('hunt-toggle').onclick) ----------
  $('route-active').onchange = async () => {
    activeRouteId = $('route-active').value;
    await chrome.storage.local.set({ activeRoute: activeRouteId });
    renderRoutes();
  };

  $('route-name').onchange = async () => {
    const active = routes.find(r => r.id === activeRouteId);
    if (!active) return;
    active.name = $('route-name').value;
    saveRoute(active);
    renderRoutes();
  };

  $('route-new').onclick = async () => {
    const name = prompt('Nombre de la nueva ruta:', 'Nueva ruta');
    if (!name) return;
    const nueva = { id: 'ruta-' + Date.now(), name, steps: [] };
    routes.push(nueva);
    activeRouteId = nueva.id;
    await chrome.storage.local.set({ routes, activeRoute: activeRouteId });
    renderRoutes();
  };

  $('route-add-step').onclick = async () => {
    const active = routes.find(r => r.id === activeRouteId);
    if (!active) return;
    active.steps.push({ lv: 0, map: 0, spot: { x: 100, y: 100 }, untilLv: 400 });
    saveRoute(active);
    renderRoutes();
  };

  $('route-delete').onclick = async () => {
    if (!confirm('¿Borrar esta ruta?')) return;
    routes = routes.filter(r => r.id !== activeRouteId);
    activeRouteId = routes[0]?.id || null;
    await chrome.storage.local.set({ routes, activeRoute: activeRouteId });
    renderRoutes();
  };

  // Rutas por defecto al abrir el panel
  function defaultRoutes() {
    return [{
      id: 'default',
      name: 'Farm estándar',
      steps: [
        { lv: 0, map: 0, spot: { x: 202, y: 124 }, untilLv: 16 },
        { lv: 16, map: 2, spot: { x: 225, y: 217 }, untilLv: 113 },
        { lv: 113, map: 10, spot: { x: 46, y: 199 }, untilLv: 400 },
      ],
    }];
  }
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
    const text = $('chat').value.trim();
    if (!text) return;
    chrome.storage.local.set({ chatMsg: text });
    chrome.runtime.sendMessage({
      target: 'bg', type: 'chat', text, keepHold: true   // ⬅️ mantiene el hold
    });
  };

  $('chat-send').onclick = doChat;
  $('chat').onkeydown = (e) => { if (e.key === 'Enter') doChat(); };

  $('ranking-btn').onclick = () => chrome.runtime.sendMessage({
    target: 'bg', type: 'chat', text: '/ranking', keepHold: true
  });

  // Botones /add str, /add agi, etc.
  ['str', 'agi', 'vit', 'ene', 'cmd'].forEach((s) => {
    const b = document.createElement('button');
    b.textContent = s.toUpperCase();
    b.title = '/add ' + s + ' (usa la cantidad del cuadro)';
    b.onclick = () => {
      const n = parseInt($('pts').value, 10);
      chrome.runtime.sendMessage({
        target: 'bg', type: 'chat',
        text: '/add ' + s + (n > 0 ? ' ' + n : ''),
        keepHold: true
      });
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

  const renderHuntList = () => {
    const mapId = +$('hunt-map').value;
    const goldens = GOLDENS_BY_MAP[mapId] || [];
    const enabled = huntCfg.enabled || {};
    const container = $('hunt-list');
    container.replaceChildren(...goldens.map((name) => {
      const btn = document.createElement('button');
      const on = enabled[name] !== false;   // por defecto sí (a menos que esté en false explícito)
      btn.className = 'chp' + (on ? ' sv' : '');
      btn.textContent = (on ? '☑ ' : '☐ ') + name;
      btn.onclick = () => {
        enabled[name] = !on;
        huntCfg.enabled = enabled;
        chrome.storage.local.set({ huntCfg });
        renderHuntList();
      };
      return btn;
    }));
    if (!goldens.length) {
      const d = document.createElement('div');
      d.className = 'empty';
      d.textContent = 'Sin Goldens definidos en este mapa.';
      container.replaceChildren(d);
    }
  };
  renderHuntList();
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
  $('hunt-toggle').onclick = () => {
    const t = $('hunt-toggle');
    const running = t.dataset.running === '1';
    const st = lastSt;

    if (!st?.ok) {
      console.warn('[panel] hunt-toggle: sin estado del juego', lastSt);
      $('hunt-status').textContent = 'No hay pestaña del juego activa.';
      return;
    }
    toContent({
      type: running ? 'hunt-stop' : 'hunt-start',
      map: huntCfg.map,
      cfg: {
        radius: huntCfg.radius,
        salt: huntCfg.salt,
        loot: huntCfg.loot,
        enabled: huntCfg.enabled || {},
      }
    });
  };

  // ---------- simulación ----------
  let simRunning = false;
  $('sim-toggle').onclick = () => {
    const t = $('sim-toggle');
    simRunning = !simRunning;
    t.textContent = simRunning ? 'SIM: ON' : 'SIM: OFF';
    t.dataset.running = simRunning ? '1' : '0';
    $('led-sim').className = 'led' + (simRunning ? ' on' : '');
    $('tv-sim').textContent = simRunning ? 'On' : 'Off';

    if (simRunning) {
      toContent({ type: 'sim-start', gridStep: +$('sim-grid-step').value || 5 });
      $('sim-status').textContent = 'Simulación iniciada...';
    } else {
      toContent({ type: 'sim-stop' });
      $('sim-status').textContent = 'Simulación detenida';
    }
  };

  $('sim-export').onclick = () => {
    toContent({ type: 'sim-export' });
  };

  $('sim-grid-step').onchange = () => {
    chrome.storage.local.set({ simGridStep: +$('sim-grid-step').value || 12 });
  };
  // ---------- datos en vivo del sim ----------
  const shNum = (n) => Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2) + 'M'
    : Math.abs(n) >= 1e3 ? (n / 1e3).toFixed(1) + 'k'
      : String(Math.round(n || 0));

  let lastSimAt = 0;
  const renderSimLive = (sim, me) => {
    const live = $('sim-live');
    const mobsEl = $('sim-mobs');
    if (!live) return;

    const kills = sim.lastKills || [];
    const stats = sim.mobStats || {};
    const names = Object.keys(stats);

    // Total acumulado de exp registrada en esta corrida
    let totalKills = 0, totalExp = 0;
    for (const n of names) {
      totalKills += stats[n].count || 0;
      totalExp += stats[n].totalExp || 0;
    }

    const t = sim.scanTarget;
    const walkLine = sim.walkMsg ? `      juego: ${sim.walkMsg}` : '';
    const last = kills[kills.length - 1];

    live.innerHTML =
      `<div style="display:flex;justify-content:space-between;gap:12px"><span style="color:#8b949e">Kills registrados</span><span style="color:#f0b429;font-weight:700">${totalKills}</span></div>` +
      `<div style="display:flex;justify-content:space-between;gap:12px"><span style="color:#8b949e">EXP registrada</span><span style="color:#3fb950;font-weight:700">${shNum(totalExp)}</span></div>` +
      `<div style="display:flex;justify-content:space-between;gap:12px"><span style="color:#8b949e">Tipos de mob</span><span style="color:#58a6ff">${names.length}</span></div>` +
      `<div style="display:flex;justify-content:space-between;gap:12px"><span style="color:#8b949e">Pos actual</span><span style="color:#c9d1d9">${me ? `(${me.x}, ${me.y})` + (me.auto ? '' : ' manual') : '—'}</span></div>` +
      (t && t.x != null ? `<div style="display:flex;justify-content:space-between;gap:12px"><span style="color:#8b949e">Yendo a</span><span style="color:#c9d1d9">(${t.x}, ${t.y})</span></div>` : '') +
      (last ? `<div style="color:#8b949e">última kill: ${last.mobName} +${shNum(last.exp)} exp</div>` : '<div style="color:#d29922">Aún no ha registrado ninguna kill. Si ves mobs muriendo y esto sigue en 0, el detector de EXP no está enganchando.</div>');

    // Tabla por tipo de mob
    if (!names.length) {
      mobsEl.replaceChildren();
      return;
    }
    const order = names.sort((a, b) => (stats[b].count || 0) - (stats[a].count || 0));
    mobsEl.replaceChildren(...order.map((n) => {
      const s = stats[n];
      const avg = s.count ? s.totalExp / s.count : 0;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;gap:8px;padding:3px 6px;background:#010409;border:1px solid #30363d;border-radius:4px;font:700 10px ui-monospace,monospace';
      const l = document.createElement('span');
      l.textContent = n;
      l.style.cssText = 'color:#a371f7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      const r = document.createElement('span');
      r.textContent = `${s.count}× · avg ${shNum(avg)}`;
      r.style.cssText = 'color:#3fb950;white-space:nowrap';
      row.append(l, r);
      return row;
    }));
  };

  // ---------- paintState (leds, tiles) ----------
  const paintState = async () => {
    const [{ run }, l, hunt] = await Promise.all([
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
    // hunt tile
    const h = lastSt?.hunt;   // lastSt ya lo actualizas en el loop
    const running = !!h?.active;
    $('led-hunt').className = 'led' + (running ? ' on' : '');
    const kills = h?.stats?.kills ?? 0;
    $('tv-hunt').textContent = running
      ? `Cazando · ${kills} kill${kills === 1 ? '' : 's'}`
      : 'Off';
    $('ts-hunt').textContent = running
      ? `${h.state} · ${h.idx}/${h.points?.length ?? 0} pts`
      : '—';

    $('hunt-toggle').textContent = running ? '⏹ Parar cacería' : '▶ Empezar cacería';
    $('hunt-toggle').className = 'b grow ' + (running ? 'stp' : 'go');
    $('hunt-toggle').dataset.running = running ? '1' : '0';

    if (running) {
      const t = h.target ? `objetivo: ${h.target.n} (${h.target.x},${h.target.y})` : '';
      $('hunt-status').textContent = [
        `mapa m${h.map}`,
        `estado: ${h.state}`,
        `kills: ${kills}`,
        t,
      ].filter(Boolean).join(' · ');
    } else {
      $('hunt-status').textContent = '—';
    }
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


      const rr = routes.find(r => r.id === activeRouteId);
      $('led-routes').className = 'led' + (rr ? ' on' : '');
      $('tv-routes').textContent = rr ? rr.name : '—';
      $('ts-routes').textContent = rr
        ? rr.steps.length + ' paso' + (rr.steps.length === 1 ? '' : 's')
        : 'sin ruta';
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

      // simulación status
      if (st.sim) {
        const sim = st.sim;
        const PHASE_LABEL = {
          idle: 'IDLE (esperando)',
          moving_to_map: 'IR A MAPA',
          scanning_map: 'PREPARANDO MAPA',
          sweeping: 'BARRIDO',
          reconnoitering: 'RECONOCIMIENTO (desatasco)',
          complete: 'COMPLETO',
        };
        const fase = PHASE_LABEL[sim.phase] || sim.phase || '—';
        const mapName = sim.currentMapName || (sim.currentMap != null ? 'm' + sim.currentMap : '—');
        $('ts-sim').textContent = sim.enabled ? fase : (fase === '—' ? '—' : 'off · ' + fase);
        $('tv-sim').textContent = sim.enabled ? 'On' : 'Off';
        $('led-sim').className = 'led' + (sim.enabled ? ' on' : '');
        $('sim-stats').textContent = `Mapa: ${mapName} | Progreso: ${sim.progress}/${sim.totalMaps}`;
        const extra = [
          sim.phase === 'sweeping' || sim.phase === 'reconnoitering'
            ? 'pierna ' + (sim.scanLeg || '?') + ' · punto ' + (sim.scanPoint || '?')
            : '',
          sim.scanTarget ? `→ (${sim.scanTarget.x}, ${sim.scanTarget.y})` : '',
          sim.walkMsg || '',
        ].filter(Boolean).join(' · ');
        $('sim-status').textContent = sim.enabled
          ? `Modo: ${fase}${extra ? ' · ' + extra : ''}`
          : 'Simulación detenida';
        renderSimLive(sim, st.me);
        lastSimAt = Date.now();
      } else {
        $('ts-sim').textContent = '—';
        $('led-sim').className = 'led';
        $('sim-live').innerHTML = '<div style="color:#8b949e">Sin datos del simulador (content no responde).</div>';
      }
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
  (async () => {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      if (ch.routes) {
        routes = ch.routes.newValue || [];
        if (!routes.find(r => r.id === activeRouteId)) {
          activeRouteId = routes[0]?.id || null;
        }
        renderRoutes();
      }
      if (ch.activeRoute) {
        activeRouteId = ch.activeRoute.newValue;
        renderRoutes();
      }
    });

    try {
      const c2 = await chrome.storage.local.get(['routes', 'activeRoute']);
      const isEmpty = !Array.isArray(c2.routes) || c2.routes.length === 0;
      routes = isEmpty ? defaultRoutes() : c2.routes;
      activeRouteId = c2.activeRoute || routes[0]?.id || null;
      if (isEmpty) {
        await chrome.storage.local.set({ routes, activeRoute: activeRouteId });
      }
      renderRoutes();
    } catch (e) {
      console.error('[panel] error cargando rutas:', e);
    }
  })();
})();