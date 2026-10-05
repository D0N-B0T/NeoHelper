// bg/debugger.js
const attached = new Set();

export async function withDebugger(tabId, fn) {
    if (!tabId) return null;
    const t = { tabId };
    const { run } = await chrome.storage.session.get('run');
    const needDetach = !attached.has(tabId);
    try {
        await chrome.debugger.attach(t, '1.3')
            .catch(e => { if (!/already attached/i.test(e.message)) throw e; });
        attached.add(tabId);
        return await fn(t);
    } finally {
        if (needDetach && (!run || run.tabId !== tabId)) {
            await chrome.debugger.detach(t).catch(() => { });
            attached.delete(tabId);
        }
    }
}