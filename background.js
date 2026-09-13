/* YouTube Contemplatif — service worker
 * Son seul rôle : ouvrir le document hors écran qui fait tourner la
 * super-résolution des miniatures (WebGPU). Le script de contenu lui parle
 * ensuite directement, sans repasser par ici.
 */
'use strict';

let creating = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Super-résolution locale des miniatures (WebGPU) hors de la page YouTube, dont la CSP interdit le WebAssembly.',
    }).catch(async (e) => {
      // Deux onglets peuvent demander l'ouverture en même temps.
      if (await chrome.offscreen.hasDocument()) return;
      throw e;
    }).finally(() => { creating = null; });
  }
  await creating;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'ytc-hd-ensure') return;
  ensureOffscreen().then(
    () => sendResponse({ ok: true }),
    (e) => sendResponse({ ok: false, error: String(e && e.message || e) }),
  );
  return true;
});
