// content/_bus.js
// Espacio compartido entre todos los módulos de content/*.js
// Se ejecuta PRIMERO (ver orden en manifest.json)

(() => {
    if (window.__MH) return;
    window.__MH = {
        // estado compartido
        tracked: new Map(),     // nombre -> { x, y, firstSeen, lastSeen, lastAlert, notified, src, name }
        me: null,               // { x, y, map, ts } posición propia detectada
        lastData: 0,            // timestamp de la última entidad vista
        cfg: {                  // configuración viva
            watch: [],
            minDist: 0,
            ttl: 15,
            meX: 226,
            meY: 236,
            resetLv: 400,
            resetBase: 0
        },
        walk: {                 // estado del autowalk
            timer: null,
            followTimer: null,
            msg: '',
            path: null,
            idx: 0
        },
        // helpers que se irán rellenando desde los módulos
        helpers: {},
        // fns de módulos que otros necesitan llamar
        api: {}
    };
})();