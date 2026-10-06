// content/cfg.js
(() => {
    const MH = window.__MH;
    if (!MH) { console.error('[MH] _bus.js no cargado'); return; }

    const DEFAULTS = {
        version: 1,

        maps: {
            0: 'Lorencia',
            1: 'Dungeon',
            2: 'Devias',
            3: 'Noria',
            4: 'LostTower',
            5: 'Exile',
            6: 'Arena',
            7: 'Atlans',
            8: 'Tarkan',
            9: 'Devil Square',
            10: 'Icarus',
            11: 'Blood Castle 1',
            12: 'Blood Castle 2',
            13: 'Blood Castle 3',
            14: 'Blood Castle 4',
            15: 'Blood Castle 5',
            16: 'Blood Castle 6',
            17: 'Blood Castle 7',
            18: 'Chaos Castle 1',
            19: 'Chaos Castle 2',
            20: 'Chaos Castle 3',
            21: 'Chaos Castle 4',
            22: 'Chaos Castle 5',
            23: 'Chaos Castle 6',
            24: 'Kalima 1',
            25: 'Kalima 2',
            26: 'Kalima 3',
            27: 'Kalima 4',
            28: 'Kalima 5',
            29: 'Kalima 6',
            30: 'Valley of Loren',
            31: 'Land of Trials',
            32: 'Devil Square 5-6',
            33: 'Aida',
            34: 'Crywolf Fortress',
            36: 'Lost Kalima',
            37: 'Kantru 1',
            38: 'Kantru 2',
            39: 'Kantru 3',
            40: 'Silent Map',
            41: 'Barracks of Balgass',
            42: 'Balgass Refuge',
            45: 'Illusion Temple 1',
            46: 'Illusion Temple 2',
            47: 'Illusion Temple 3',
            48: 'Illusion Temple 4',
            49: 'Illusion Temple 5',
            50: 'Illusion Temple 6',
            51: 'Elbeland',
            52: 'Blood Castle 8',
            53: 'Chaos Castle 7',
            56: 'Swamp of Calmness',
            57: 'Raklion',
            58: 'Raklion Boss',
            62: "Village's Santa",
            63: 'Vulcanus',
            64: 'Duel Arena',
        },

        // Variantes /move por mapa. NO usar un objeto con claves repetidas:
        // en un literal gana la ultima, asi que `moveCommands[2]` quedaba en
        // '/move devias4' y los pasos de Devias intentaban ir siempre al 4.
        // Este array conserva TODAS las variantes y ademas sobrevive a
        // deepMerge (los arrays no se fusionan).
        mapVariants: [
            [0, ['/move lorencia']],
            [2, ['/move devias', '/move devias2', '/move devias3', '/move devias4']],
            [1, ['/move dungeon', '/move dungeon2', '/move dungeon3']],
            [6, ['/move arena', '/move arena2', '/move arena3', '/move arena4']],
            [4, ['/move losttower', '/move losttower2', '/move losttower3', '/move losttower4', '/move losttower5', '/move losttower6', '/move losttower7']],
            [7, ['/move atlans', '/move atlans2', '/move atlans3']],
            [8, ['/move tarkan', '/move tarkan2']],
            [10, ['/move icarus']],
        ],

        goldens: {
            0: ['Golden Goblin', 'Golden Dragon'],
            2: ['Golden Titan', 'Golden Dragon'],
            3: ['Golden Goblin', 'Golden Dragon'],
            7: ['Golden Lizard King'],
            8: ['Golden Tantalos'],
        },

        commands: {
            reset: '/reset',
            autoParty: '/autoparty on',
            ranking: '/ranking',
        },

        selectors: {
            chatField: '.v097d-chat-field.line.to-normal',
            gameCanvas: '.game-canvas',
            charSelPlate: '.char-sel-plate',
        },

        keys: {
            pickup: 'Space',
            enter: 'Enter',
            stop: 'Escape',
        },

        defaults: {
            holdButton: 'right',
            holdRepeat: 300,
            walkTick: 150,
            walkLookahead: 10,
            walkMaxStill: 24,
            huntSalt: 12,
            huntRadius: 40,
            alertCooldownMs: 60000,
            entityTtl: 15,
            meFallbackX: 226,
            meFallbackY: 236,
        },
    };

    const deepMerge = (base, override) => {
        const out = { ...base };
        for (const k of Object.keys(override || {})) {
            const v = override[k];
            if (v === null || v === undefined) continue;
            if (typeof v === 'object' && !Array.isArray(v) &&
                typeof base[k] === 'object' && !Array.isArray(base[k])) {
                out[k] = deepMerge(base[k], v);
            } else {
                out[k] = v;
            }
        }
        return out;
    };

    // Derivado de mapVariants: comando principal por mapa. Se recalcula tras
    // cada carga de cfg para que siga siendo valido (un objeto plano no puede
    // guardar las variantes: las claves repetidas se perderian).
    const rebuildMoveCommands = () => {
        const v = MH.cfg.mu.mapVariants || DEFAULTS.mapVariants || [];
        MH.cfg.mu.moveCommands = {};
        for (const [id, cmds] of v) if (cmds && cmds.length) MH.cfg.mu.moveCommands[id] = cmds[0];
        MH.api.mapVariants = (id) => {
            const row = v.find(([i]) => +i === +id);
            return row ? row[1].slice() : [];
        };
    };

    MH.cfg.mu = deepMerge(DEFAULTS, {});
    rebuildMoveCommands();

    chrome.storage.local.get('cfg').then((c) => {
        if (c.cfg) {
            MH.cfg.mu = deepMerge(DEFAULTS, c.cfg);
            rebuildMoveCommands();
            console.log('[MH-CFG] config cargada de storage');
        }
    }).catch(() => { });

    chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'local' && ch.cfg) {
            MH.cfg.mu = deepMerge(DEFAULTS, ch.cfg.newValue || {});
            rebuildMoveCommands();
            console.log('[MH-CFG] config actualizada en vivo');
        }
    });

    MH.api.getCfg = () => MH.cfg.mu;
    MH.api.setCfg = async (partial) => {
        const current = (await chrome.storage.local.get('cfg')).cfg || {};
        const next = deepMerge(current, partial);
        await chrome.storage.local.set({ cfg: next });
    };
    MH.api.resetCfg = async () => {
        await chrome.storage.local.remove('cfg');
    };

    console.log('[MH] cfg.js cargado');
})();