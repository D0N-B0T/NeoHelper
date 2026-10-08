// popup.js
import {
  $, GAME_URL, findGameTab, sendToGame,
  decodeTerrain, decodeHeat, drawMap,
  renderPlayersTable, createEventLog,
  loadSavedLocs, saveSavedLocs, splitNames
} from './ui/shared.js';

(async () => {
  // ---------- carga inicial ----------
  const c = await chrome.storage.local.get([
    'button', 'x', 'y', 'repeat', 'chatMsg', 'statPts', 'chatX', 'chatY', 'resetLv',
    'watchlist', 'radarMinDist', 'radarTTL', 'radarMeX', 'radarMeY', 'savedLocs', 'uiTile',
    'espCfg', 'autoCfg', 'resetBase', 'huntCfg', 'simGridStep', 'mapLayers', 'heatModes'
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

  // ---------- riel de herramientas -> hoja lateral ----------
  const SHEET_TITLES = { auto: 'Auto · credenciales', esp: 'ESP', hunt: 'Caza', routes: 'Rutas', sim: 'Simulación', chat: 'Chat', ranking: 'Ranking', hold: 'Hold · mantener mouse' };
  let curSheet = null;
  const openSheet = (k) => {
    curSheet = k;
    document.querySelectorAll('#rail .rb').forEach((b) => b.classList.toggle('act', b.dataset.s === (k || 'radar')));
    document.querySelectorAll('#sheet .p').forEach((p) => p.classList.toggle('act', p.id === 'p-' + k));
    $('sht').textContent = SHEET_TITLES[k] || '';
    $('sheet').dataset.k = k || '';
    $('sheet').classList.toggle('on', !!k);
  };
  // radar = vista principal (cierra la hoja); repetir la misma herramienta también la cierra
  document.querySelectorAll('[data-s]').forEach((b) => {
    b.onclick = () => openSheet(b.dataset.s === 'radar' || b.dataset.s === curSheet ? null : b.dataset.s);
  });
  $('shx').onclick = () => openSheet(null);
  openSheet(null);

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

  // ---------- hold (toggle del footer: Mantener <-> Soltar) ----------
  let holdRun = null;   // lo refresca paintState desde storage.session
  $('f-hold').onclick = async () => {
    if (holdRun) return chrome.runtime.sendMessage({ target: 'bg', type: 'stop' });
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

  $('ranking-btn').onclick = () => { openSheet('ranking'); loadRanking(); };

  // ---------- ranking (API directa del servidor) ----------
  // https://mu.mormon.garden/api/ranking
  const RK_URL = 'https://mu.mormon.garden/api/ranking';
  const RK_TTL = 30000;            // 30 s de caché en memoria
  const RK_REFRESH = 300000;       // auto-refresh cada 5 min
  const RK_CLASS = { 0: 'DW', 1: 'DK', 2: 'FE', 3: 'MG', 4: 'DL', 5: 'SU', 6: 'BK', 7: 'ME', 8: 'BS', 9: 'RF', 10: 'ELF', 11: 'SM', 12: 'MG' };
  let rkCache = { t: 0, data: null };
  let rkView = 'resets';
  let rkTimer = null;              // setInterval del auto-refresh

  const rkClass = (c) => c == null ? '—' : (c === 2 ? 'BK' : (RK_CLASS[c] || 'C' + c));
  const rkAgo = (iso) => {
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (!Number.isFinite(s) || s < 0) return '';
    return s < 60 ? `hace ${s}s` : s < 3600 ? `hace ${Math.floor(s / 60)}m` : `hace ${Math.floor(s / 3600)}h`;
  };

  const renderRanking = () => {
    const d = rkCache.data;
    const list = $('rk-list');
    if (!d) { list.innerHTML = '<div class="empty">Sin datos. Pulsa ↻.</div>'; return; }
    const all = d[rkView] || [];
    if (!all.length) { list.innerHTML = '<div class="empty">Sin filas.</div>'; return; }
    const key = rkView === 'resets' ? 'totalResets' : 'elo';
    const unit = rkView === 'resets' ? 'R' : ' ELO';
    const me = $('auto-char').value.trim().toLowerCase();
    const myIdx = me ? all.findIndex((r) => (r.name || '').toLowerCase() === me) : -1;

    // línea de estado: antigüedad de los datos + tu puesto y la brecha con el de arriba
    const ago = rkAgo(d.updatedAt || '');
    let info = ago ? 'Actualizado ' + ago : 'Consultado ' + rkAgo(new Date(rkCache.t).toISOString());
    if (myIdx >= 0) {
      const up = all[myIdx - 1];
      info += ` · Tú #${myIdx + 1}` + (up ? ` · faltan ${Math.max(0, up[key] - all[myIdx][key])}${unit} para ${up.name}` : ' · vas primero');
    }
    $('rk-updated').textContent = info;

    // cabecera fija + filas en columnas alineadas; tu personaje queda anclado al hacer scroll
    const head = document.createElement('div');
    head.className = 'rk-head';
    head.append(...['#', 'Nombre', 'Cls', ...(rkView === 'resets' ? ['Resets', 'GR', 'Lv'] : ['ELO', 'W', 'L'])]
      .map((t) => { const s = document.createElement('span'); s.textContent = t; return s; }));

    const rows = all.slice(0, 50).map((r, i) => [r, i]);
    if (myIdx >= 50) rows.push([all[myIdx], myIdx]);   // fuera del top 50: se agrega con su puesto real
    list.replaceChildren(head, ...rows.map(([r, i]) => {
      const row = document.createElement('div');
      row.className = 'rk-row' + (i < 3 ? ' top' : '') + (i === myIdx ? ' me' : '');
      row.title = `clase ${r.classNumber}`;
      const base = [['rk-p', i + 1], ['rk-n', r.name], ['rk-cls', rkClass(r.classNumber)]];
      const vals = rkView === 'resets'
        ? [...base, ['rk-res', r.totalResets], ['rk-gr' + (r.grandResets ? '' : ' z'), r.grandResets], ['rk-lv' + (r.level >= 400 ? ' max' : ''), r.level]]
        : [...base, ['rk-res', r.elo], ['rk-w', r.wins], ['rk-l', r.losses]];
      row.append(...vals.map(([cls, txt]) => { const sp = document.createElement('span'); sp.className = cls; sp.textContent = txt; return sp; }));
      return row;
    }));
  };

  async function loadRanking(force) {
    if (!force && rkCache.data && Date.now() - rkCache.t < RK_TTL) { renderRanking(); return; }
    const st = $('ts-ranking');
    if (st) st.textContent = 'cargando…';
    try {
      const resp = await fetch(RK_URL, { cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      rkCache = { t: Date.now(), data: await resp.json() };
      if (st) st.textContent = 'API';
      renderRanking();
    } catch (e) {
      if (st) st.textContent = 'error: ' + (e?.message || e);
      if (rkCache.data) renderRanking();
    }
  }

  $('rk-tabs').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      rkView = b.dataset.v;
      $('rk-tabs').querySelectorAll('button').forEach((x) => x.classList.toggle('act', x === b));
      renderRanking();
    };
  });
  $('rank-reload').onclick = () => loadRanking(true);

  // Auto-refresh: cada 5 min mientras la hoja de ranking esté abierta.
  const rkAutoRefresh = () => {
    clearInterval(rkTimer);
    rkTimer = setInterval(() => {
      if (curSheet !== 'ranking') return;      // no molesta si el panel está cerrado
      if (document.hidden) return;             // no refresca en pestañas ocultas
      loadRanking(true);
    }, RK_REFRESH);
  };
  rkAutoRefresh();
  // Al abrir el panel, refresca si los datos ya pasaron de 5 min.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !rkCache.data) return;
    if (Date.now() - rkCache.t >= RK_REFRESH) loadRanking(true);
  });

  // Botones /add str, /add agi, etc.
  const STAT_KEYS = ['str', 'agi', 'vit', 'ene', 'cmd'];
  // Puntos libres reales del personaje (llegan del juego en el ciclo de 500 ms).
  // El slider reparte SOBRE ESTO, no sobre la cajita manual #pts.
  let livePts = 0;
  const statsPoints = () => {
    const n = parseInt($('pts').value, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  // Base del reparto: los puntos libres del juego si los conocemos;
  // si aún no han llegado (o son 0), cae al valor de la cajita manual.
  const basePts = () => (livePts > 0 ? livePts : statsPoints());
  // Reparto masivo: usa los puntos libres que quedan en el juego.
  // Manda /add <stat> <n> en bloques: un solo chat con miles de números
  // se corta en el juego.
  const queueAdd = async (stat, total) => {
    for (let i = 0; i < 90 && total > 0; i++) {
      const step = Math.min(255, total);
      total -= step;
      chrome.runtime.sendMessage({
        target: 'bg', type: 'chat',
        text: '/add ' + stat + ' ' + step,
        keepHold: true
      }).catch(() => { });
      await new Promise(r => setTimeout(r, 900));
    }
  };
  const updatePtsUI = (total = basePts()) => {
    const pct = +$('pts-slider').value || 0;
    const n = Math.floor(total * pct / 100);
    $('pts-live').textContent = pct + '%';
    $('pts-note').textContent = total > 0
      ? `Libres${livePts > 0 ? ' (juego)' : ' (manual)'}: ${total} · repartir ${n} al botón`
      : 'Sin puntos detectados. Abre el juego para que lleguen.';
    $('pts-apply').disabled = !(total > 0 && n > 0);
    return n;
  };
  $('pts-slider').oninput = () => updatePtsUI();
  $('pts').oninput = () => updatePtsUI();
  $('pts-apply').onclick = () => { const n = updatePtsUI(); if (n > 0) $('pts').value = n; };
  $('pts-max').onclick = () => { $('pts-slider').value = '100'; const n = updatePtsUI(); if (n > 0) $('pts').value = n; };
  STAT_KEYS.forEach((s) => {
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

  // Botón ✎ de cada stat: reparte el tramo del slider en ese stat
  STAT_KEYS.forEach((s) => {
    const b = document.createElement('button');
    b.textContent = '✎ ' + s.toUpperCase();
    b.title = 'Repartir al ' + s + ' el % del slider (puntos libres)';
    b.onclick = async () => {
      const n = updatePtsUI();
      if (!n) return;
      b.disabled = true;
      b.textContent = '⏳ ' + s.toUpperCase();
      await queueAdd(s, n);
      b.disabled = false;
      b.textContent = '✎ ' + s.toUpperCase();
    };
    $('pts-max').parentElement.appendChild(b);
  });
  updatePtsUI();

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
  let prevHits = new Set(), prevWalking = false, prevMapSeen = null, prevAuto = null, lastErr = null, walkDest = null;
  let prevHunt = null, prevKills = 0, trailMap = null;

  // ---------- capas, zoom y rastro del mapa ----------
  const LAYERS = Object.assign({ mobs: true, jug: true, spots: true, ruta: true, rastro: true }, c.mapLayers || {});
  document.querySelectorAll('#layers [data-l]').forEach((b) => {
    b.classList.toggle('off', !LAYERS[b.dataset.l]);
    b.onclick = () => {
      LAYERS[b.dataset.l] = !LAYERS[b.dataset.l];
      b.classList.toggle('off', !LAYERS[b.dataset.l]);
      chrome.storage.local.set({ mapLayers: LAYERS });
    };
  });
  const ZOOMS = [1, 1.5, 2, 3, 4, 6];
  let zoomIdx = 0;
  const view = { x: 128, y: 128 };   // centro de la ventana (tiles); sigue al jugador
  const trail = [];                  // últimos tiles recorridos
  const zoomTo = (i) => {
    zoomIdx = Math.max(0, Math.min(ZOOMS.length - 1, i));
    $('zoom-reset').textContent = ZOOMS[zoomIdx] + '×';
  };
  // calor del mapa: modo por mapa (el pasillo saturado de Icarus no es el de Lorencia)
  const HEAT_MODES = Object.assign({}, c.heatModes);   // { mapId: 'nucleos' | 'tenue' | 'completo' | 'off' }
  const HEAT_CYCLE = ['nucleos', 'tenue', 'completo', 'off'];
  const heatOf = (m) => HEAT_MODES[m] || 'nucleos';
  const paintHeatChip = () => { $('heat-mode').textContent = 'Calor: ' + heatOf(lastSt?.map).replace('nucleos', 'núcleos'); };
  $('heat-mode').onclick = () => {
    const m = lastSt?.map;
    if (m == null) return;
    HEAT_MODES[m] = HEAT_CYCLE[(HEAT_CYCLE.indexOf(heatOf(m)) + 1) % HEAT_CYCLE.length];
    chrome.storage.local.set({ heatModes: HEAT_MODES });
    heatAt = 0;   // fuerza re-decodificar el heatmap en el próximo ciclo
    paintHeatChip();
  };
  $('zoom-in').onclick = () => zoomTo(zoomIdx + 1);
  $('zoom-out').onclick = () => zoomTo(zoomIdx - 1);
  $('zoom-reset').onclick = () => zoomTo(0);
  $('map').addEventListener('wheel', (e) => { e.preventDefault(); zoomTo(zoomIdx + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });

  const evRaw = createEventLog($('evlog'));
  let curTab = 'spots';
  // ev(msg, cls, notify): todo va al Registro; lo relevante (notify=true) marca la pestaña con un punto rojo
  const ev = (msg, cls, notify) => {
    evRaw(msg, cls);
    $('tick').textContent = new Date().toTimeString().slice(0, 5) + ' ' + msg;
    $('tick').className = 'tick ' + (cls || '');
    if (notify && curTab !== 'log') $('tab-log').classList.add('new');
  };
  document.querySelectorAll('#tabs .tb').forEach((b) => {
    b.onclick = () => {
      curTab = b.dataset.t;
      document.querySelectorAll('#tabs .tb').forEach((x) => x.classList.toggle('act', x === b));
      document.querySelectorAll('.pane').forEach((p) => { p.hidden = p.id !== 'pane-' + curTab; });
      if (curTab === 'log') b.classList.remove('new');
    };
  });

  // ---------- listas: spots de mobs + mis ubicaciones ----------
  // rebuild=true recrea las filas (cambio de mapa / spots / guardados); false solo refresca las distancias
  let listRows = [];
  const hue = (n) => { let h = 0; for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
  const paintLists = (rebuild) => {
    const me = lastSt?.ok ? lastSt.me : null;
    if (rebuild) {
      listRows = [];
      const row = (cls, color, name, x, y, tag, onGo, onDel) => {
        const r = document.createElement('div');
        r.className = 'lrow ' + cls;
        const go = document.createElement('button');
        go.className = 'lgo';
        go.title = 'Clic: ir a (' + x + ', ' + y + ')';
        go.onclick = onGo;
        const dot = document.createElement('i'); dot.className = 'dot'; dot.style.background = color;
        const nm = document.createElement('span'); nm.className = 'ln'; nm.textContent = name;
        const cc = document.createElement('span'); cc.className = 'lc'; cc.textContent = x + ',' + y + (tag ? ' · ' + tag : '');
        const ds = document.createElement('span'); ds.className = 'ld';
        const mc = document.createElement('span'); mc.className = 'lm';
        go.append(dot, nm, cc, mc, ds);
        r.append(go);
        if (onDel) {
          const del = document.createElement('button');
          del.className = 'ldel'; del.textContent = '✕'; del.title = 'Borrar';
          del.onclick = (e) => { e.stopPropagation(); onDel(); };
          r.append(del);
        }
        listRows.push({ ds, mc, x, y, far: cls === 'other', spot: cls === '' });
        return r;
      };
      const empty = (t) => { const d = document.createElement('div'); d.className = 'empty'; d.textContent = t; return d; };
      const dd = (p) => me ? Math.hypot(p.x - me.x, p.y - me.y) : 0;

      const spots = [...heatSpots].sort((p, q) => dd(p) - dd(q));
      $('spots-count').textContent = spots.length;
      $('locs-count').textContent = savedLocs.length;
      $('spots-list').replaceChildren(...(spots.length
        ? spots.map((p) => row('', `hsl(${hue(p.n)} 70% 60%)`, p.n, p.x, p.y, '', () => sendToGame({ type: 'goto', x: p.x, y: p.y }), null))
        : [empty('Sin spots en este mapa.')]));

      $('locs-list').replaceChildren(...(savedLocs.length
        ? savedLocs.map((l, i) => {
          const other = lastSt?.map != null && l.map != null && l.map !== lastSt.map;
          return row(other ? 'other' : 'sv', other ? '#d29922' : '#3fb950', l.name, l.x, l.y, l.map != null ? 'm' + l.map : '',
            () => sendToGame({ type: 'goto', x: l.x, y: l.y }),
            () => { savedLocs.splice(i, 1); saveSavedLocs(savedLocs); paintLists(true); });
        })
        : [empty('Sin ubicaciones guardadas.')]));
    }
    const mobsNow = lastSt?.mobs || [];
    for (const r of listRows) {
      r.ds.textContent = me && !r.far ? Math.round(Math.hypot(r.x - me.x, r.y - me.y)) + 't' : '';
      if (r.spot) {   // mobs visibles a <=12 tiles del spot
        const n = mobsNow.reduce((k, m) => k + (Math.hypot((m.x ?? m[1]) - r.x, (m.y ?? m[2]) - r.y) <= 12 ? 1 : 0), 0);
        r.mc.textContent = n ? '×' + n : '';
        r.mc.title = n + ' mobs a ≤12t del spot';
      }
    }
    // lectura "spot cercano" junto al mapa
    let best = null;
    if (me) for (const p of heatSpots) { const d = Math.hypot(p.x - me.x, p.y - me.y); if (!best || d < best.d) best = { n: p.n, d }; }
    $('rd-spot').textContent = best ? best.n : '—';
    $('rd-spot-d').textContent = best ? Math.round(best.d) + 't' : '';
  };
  const saveHere = (withName) => {
    if (!lastSt?.ok) { $('hud').textContent = 'Sin datos del juego.'; return; }
    const { x, y } = lastSt.me;
    const nm = withName ? prompt('Nombre:', 'Spot ' + (savedLocs.length + 1)) : '';
    if (nm === null) return;
    savedLocs.push({ name: (nm || '').trim() || `Pos (${x}, ${y})`, x, y, map: lastSt.map });
    if (savedLocs.length > 100) savedLocs.shift();
    saveSavedLocs(savedLocs);
    paintLists(true);
  };
  $('save-cur').onclick = () => saveHere(false);
  $('save-as').onclick = () => saveHere(true);
  paintLists(true);

  $('goto-btn').onclick = () => {
    if ($('goto-x').value === '' || $('goto-y').value === '') return;
    sendToGame({ type: 'goto', x: +$('goto-x').value, y: +$('goto-y').value });
  };
  $('map').onclick = (e) => {
    const r = e.target.getBoundingClientRect();
    const v = 256 / ZOOMS[zoomIdx];
    const sx = 1 - (e.clientX - r.left) / r.width;   // el canvas está espejado en X por CSS
    const sy = (e.clientY - r.top) / r.height;
    sendToGame({
      type: 'goto',
      x: Math.max(0, Math.min(255, Math.round(view.x - v / 2 + sx * v))),
      y: Math.max(0, Math.min(255, Math.round(view.y - v / 2 + sy * v)))
    });
  };
  $('map').oncontextmenu = (e) => { e.preventDefault(); sendToGame({ type: 'stopwalk' }); };
  // footer: Parar movimiento <-> Reanudar (vuelve al último destino visto)
  $('f-walk').onclick = () => {
    if (lastSt?.walking) sendToGame({ type: 'stopwalk' });
    else if (walkDest) sendToGame({ type: 'goto', x: walkDest[0], y: walkDest[1] });
  };
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
    // footer: Mantener <-> Soltar
    holdRun = run || null;
    $('f-hold').textContent = run ? '⛔ Soltar mouse' : '🖱 Mantener ' + $('btn').selectedOptions[0].text.toLowerCase();
    $('f-hold').className = 'b grow ' + (run ? 'stp' : 'go');
    // footer: Parar <-> Reanudar
    const walking = !!lastSt?.walking;
    $('f-walk').textContent = walking ? '🚶 Parar movimiento (Esc)' : walkDest ? `▶ Reanudar (${walkDest[0]}, ${walkDest[1]})` : '🚶 Sin destino';
    $('f-walk').className = 'b grow ' + (walking ? 'stp' : walkDest ? 'blue' : 'stp2');
    $('f-walk').disabled = !walking && !walkDest;

    const zone = $('chatx').value !== '' && $('chaty').value !== '';
    $('led-chat').className = 'led' + (zone ? ' on' : '');
    $('ts-chat').textContent = zone ? `zona ${$('chatx').value},${$('chaty').value}` : 'sin zona';

    $('led-esp').className = 'led' + (l.espEnabled ? ' on' : '');
    $('tv-esp').textContent = l.espEnabled ? 'On' : 'Off';
    $('ts-esp').textContent = l.espCfg?.maxDist ? `≤ ${l.espCfg.maxDist} tiles` : 'sin límite';
    $('esp-toggle').textContent = 'ESP: ' + (l.espEnabled ? 'ON' : 'OFF');
    $('esp-toggle').className = 'b grow ' + (l.espEnabled ? 'tg-on' : 'tg-off');

    const a = l.autoState;
    const on = !!l.autoEnabled;
    $('auto-toggle').classList.toggle('on', on);
    $('auto-lbl').textContent = on ? 'ON' : 'OFF';
    $('auto-status').textContent = a ? `${a.phase} · char ${a.charLevel} · lv ${a.lv} · m${a.map} · ${a.cls}` : (on ? 'iniciando…' : 'detenido');
    if (prevAuto && on !== prevAuto.on) ev('Auto ' + (on ? 'ON' : 'OFF'), on ? 'ok' : 'warn', true);
    else if (prevAuto && on && a && a.phase !== prevAuto.phase) ev('Auto: fase ' + a.phase, 'ok', true);
    if (a && prevAuto?.lvl != null && a.charLevel !== prevAuto.lvl) {
      if (a.charLevel < prevAuto.lvl) ev('reset · nivel ' + a.charLevel, 'warn', true);
      else if (a.charLevel % 10 === 0) ev('nivel ' + a.charLevel, 'ok');
    }
    prevAuto = { on, phase: a?.phase, lvl: a?.charLevel };
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
    if (prevHunt != null && running !== prevHunt) ev('cacería ' + (running ? 'iniciada' : 'detenida'), running ? 'ok' : 'warn', true);
    if (running && kills && kills !== prevKills && kills % 10 === 0) ev(kills + ' kills de cacería', 'ok');
    prevHunt = running; prevKills = kills;

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
        $('pl-count').textContent = '0';
        $('rd-mobs').textContent = '—';
        $('radar-container').innerHTML = '<div class="empty">Sin datos aún.</div>';
        $('led-radar').className = 'led';
        $('tv-radar').textContent = 'Sin datos';
        $('ts-radar').textContent = '—';
        document.body.classList.remove('alert');
        return;
      }

      lastSt = st;
      // Puntos libres del juego: si los sabemos, el cuadro se actualiza solo
      // (así el slider y los botones ✎ reparten siempre lo que queda de verdad).
      livePts = st.pts > 0 ? st.pts : 0;
      if (livePts > 0 && +$('pts').value !== livePts) $('pts').value = livePts;
      updatePtsUI();
      if (st.walking && st.route?.length) walkDest = st.route[st.route.length - 1];
      if (st.map !== prevMapSeen) {
        if (prevMapSeen != null) ev('cambio a mapa m' + st.map, 'warn');
        prevMapSeen = st.map;
        paintLists(true);
      }


      const rr = routes.find(r => r.id === activeRouteId);
      $('led-routes').className = 'led' + (rr ? ' on' : '');
      $('tv-routes').textContent = rr ? rr.name : '—';
      $('ts-routes').textContent = rr
        ? rr.steps.length + ' paso' + (rr.steps.length === 1 ? '' : 's')
        : 'sin ruta';
      $('rd-route').textContent = rr ? rr.name : '—';
      $('rd-route-n').textContent = $('ts-routes').textContent;
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
        const decoded = decodeHeat(raw, heatOf(st.map));
        paintHeatChip();
        heatImg = decoded.img;
        heatSpots = decoded.spots;
        paintLists(true);
      }
      paintLists(false);

      // rastro (se corta en teletransportes / cambio de mapa)
      if (st.map !== trailMap) { trail.length = 0; trailMap = st.map; }
      const lt = trail[trail.length - 1];
      if (lt && Math.hypot(lt[0] - st.me.x, lt[1] - st.me.y) > 15) trail.length = 0;
      if (!lt || lt[0] !== st.me.x || lt[1] !== st.me.y) { trail.push([st.me.x, st.me.y]); if (trail.length > 150) trail.shift(); }

      // dibujo (con capas y zoom; la ventana sigue al jugador)
      const z = ZOOMS[zoomIdx], v = 256 / z, half = v / 2;
      view.x = Math.max(half, Math.min(256 - half, st.me.x));
      view.y = Math.max(half, Math.min(256 - half, st.me.y));
      g.setTransform(1, 0, 0, 1, 0, 0);
      if (z !== 1) { g.clearRect(0, 0, 256, 256); g.translate(128, 128); g.scale(z, z); g.translate(-view.x, -view.y); }
      drawMap($('map'), {
        terrain, heatImg: heatOf(st.map) !== 'off' ? heatImg : null,
        mobs: LAYERS.mobs ? st.mobs : [], players: LAYERS.jug ? lista : [], watch,
        route: LAYERS.ruta ? st.route : undefined, routeIdx: st.routeIdx,
        me: st.me, heatSpots: LAYERS.spots ? heatSpots : []
      });
      if (LAYERS.rastro && trail.length > 1) {
        g.lineWidth = 1;
        for (let i = 1; i < trail.length; i++) {
          g.strokeStyle = `rgba(63,185,80,${0.15 + 0.7 * i / trail.length})`;
          g.beginPath(); g.moveTo(trail[i - 1][0] + .5, trail[i - 1][1] + .5); g.lineTo(trail[i][0] + .5, trail[i][1] + .5); g.stroke();
        }
      }
      g.setTransform(1, 0, 0, 1, 0, 0);
      if (curSheet) $('mini').getContext('2d').drawImage($('map'), 0, 0);   // mini mapa dentro de la hoja

      // etiquetas de alerta sobre el mapa (respetan el zoom)
      $('cals').replaceChildren(...hits.slice(0, 4).map((p) => {
        const fx = (p.x - (view.x - half)) / v, fy = (p.y - (view.y - half)) / v;
        if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
        const d = document.createElement('div');
        const lx = (1 - fx) * 100;   // espejado por CSS
        d.className = 'cal';
        d.textContent = p.n + ' · ' + p.dist + 't';
        d.style.top = `calc(${fy * 100}% - 22px)`;
        if (lx > 60) d.style.right = (100 - lx) + '%';
        else d.style.left = lx + '%';
        return d;
      }).filter(Boolean));

      // log
      const nowHits = new Set(hits.map((p) => p.n));
      hits.forEach((p) => { if (!prevHits.has(p.n)) ev(p.n + ' entró a ' + p.dist + 't', 'bad', true); });
      prevHits.forEach((n) => { if (!nowHits.has(n)) ev(n + ' salió', 'warn', true); });
      prevHits = nowHits;
      if (st.walking && !prevWalking) ev('autowalk' + (st.route?.length ? ' → (' + st.route[st.route.length - 1].join(',') + ')' : ' iniciado'), 'ok');
      if (!st.walking && prevWalking) ev('autowalk terminó', 'warn');
      prevWalking = !!st.walking;

      // cabecera / hud / radar tile
      $('hdr').textContent = (st.map != null ? 'm' + st.map + ' · ' : '') + st.me.x + ', ' + st.me.y + (st.me.auto ? '' : ' manual');
      $('rd-mobs').textContent = st.mobs?.length ?? 0;

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
      document.body.classList.toggle('alert', hits.length > 0);
      $('mini-info').className = 'mi' + (hits.length ? ' al' : '');
      $('mini-info').textContent = `m${st.map ?? '?'} · ${st.me.x}, ${st.me.y}\n${st.mobs?.length ?? 0} mobs · ${lista.length} jug\n` +
        (hits.length ? `⚠ ${hits[0].n} ${hits[0].dist}t` + (hits.length > 1 ? ` (+${hits.length - 1})` : '') : 'sin vigilados cerca');

      // tabla
      $('pl-count').textContent = lista.length;
      renderPlayersTable($('radar-container'), lista, {
        watch, minDist, ttl,
        onGo: (x, y) => sendToGame({ type: 'goto', x, y }),
        onFollow: (n) => sendToGame({ type: 'follow', name: n })
      });
    } catch (e) {
      $('hud').textContent = 'Error: ' + e.message;
      $('hud').classList.add('err');
      if (e.message !== lastErr) { lastErr = e.message; ev('Error: ' + e.message, 'bad', true); }
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