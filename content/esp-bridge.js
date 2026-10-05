// content/esp-bridge.js
// Puente entre content script (isolated) y el overlay ESP en MAIN world.
// El ESP en sí vive en game/esp.js (MAIN world). Aquí solo reenviamos eventos.

(() => {
    const espToMain = (msg) => window.dispatchEvent(
        new CustomEvent('mh-esp', { detail: JSON.stringify(msg) })
    );

    // El overlay MAIN world avisa cuando cambia su "pointer-events"
    window.addEventListener('mh-esp-clickthrough', (ev) => {
        try {
            const { clickable } = JSON.parse(ev.detail);
            const c = document.getElementById('__mh_esp_overlay');
            if (c) c.style.pointerEvents = clickable ? 'auto' : 'none';
        } catch (_) { }
    });

    // Estado inicial
    chrome.storage.local.get(['espEnabled', 'espCfg'], (c) => {
        espToMain({ type: 'toggle', value: !!c.espEnabled });
        if (c.espCfg) espToMain({ type: 'cfg', value: c.espCfg });
    });

    // Cambios en vivo
    chrome.storage.onChanged.addListener((ch, area) => {
        if (area !== 'local') return;
        if (ch.espEnabled) espToMain({ type: 'toggle', value: !!ch.espEnabled.newValue });
        if (ch.espCfg) espToMain({ type: 'cfg', value: ch.espCfg.newValue || {} });
    });

    console.log('[MH] esp-bridge.js cargado');
})();