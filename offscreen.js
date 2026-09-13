/* YouTube Contemplatif — document hors écran : super-résolution des miniatures
 *
 * Les miniatures YouTube plafonnent à 1280 × 720. Ce document, hors de la page
 * YouTube (dont la CSP interdit le WebAssembly), fait tourner un modèle
 * Real-ESRGAN compact (realesr-general-x4v3, ≈ 5 Mo) avec ONNX Runtime Web sur
 * le GPU de la machine via WebGPU. Rien ne quitte l'ordinateur : le seul
 * accès réseau est le téléchargement de la miniature elle-même.
 *
 * Le modèle sort du ×4 ; on redescend en ×2 par moyenne 2 × 2, ce qui lisse
 * ses petits artefacts et suffit pour un écran Retina. Les images sont
 * traitées par tuiles de taille fixe (un seul jeu de shaders à compiler) avec
 * une marge réplicée sur les bords pour éviter les coutures. Les résultats
 * sont conservés dans le Cache API de l'extension : une image n'est jamais
 * calculée deux fois.
 */
(() => {
  'use strict';

  const MODEL_URL = chrome.runtime.getURL('models/realesr-general-x4v3.onnx');
  const MODEL_SCALE = 4;
  const OUT_SCALE = 2;
  // GRAIN : le modèle efface le grain des illustrations ; on réinjecte les hautes
  // fréquences de l'originale (originale − floutée) avec ce poids. 0 = désactivé.
  const cfg = { TILE_W: 640, TILE_H: 360, GRAIN: 0.6 }; // modifiable depuis la console pour les essais
  const PAD = 16;
  const WEBP_QUALITY = 0.92;
  const CACHE_NAME = 'ytc-hd-general-x4v3-v2';
  const CACHE_MAX = 400;
  const CACHE_PREFIX = 'https://ytc.local/hd/';

  ort.env.wasm.wasmPaths = chrome.runtime.getURL('vendor/ort/');
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'error';

  /* ------------------------------------------------------------------ */
  /* Session                                                             */
  /* ------------------------------------------------------------------ */

  let sessionPromise = null;
  let fatal = null; // erreur définitive (pas de WebGPU, modèle illisible…)

  function getSession() {
    if (!sessionPromise) {
      sessionPromise = (async () => {
        if (!navigator.gpu) throw new Error('WebGPU indisponible');
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error('Aucun adaptateur WebGPU');
        return ort.InferenceSession.create(MODEL_URL, {
          executionProviders: ['webgpu'],
          graphOptimizationLevel: 'all',
        });
      })().catch((e) => { fatal = e; throw e; });
    }
    return sessionPromise;
  }

  /* ------------------------------------------------------------------ */
  /* Image → pixels                                                      */
  /* ------------------------------------------------------------------ */

  async function fetchBitmap(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} pour ${url}`);
    return createImageBitmap(await res.blob());
  }

  async function loadImage(url, fallback) {
    let bmp = null;
    // maxresdefault absent → YouTube renvoie un placeholder 120×90, ou une 404.
    const useFallback = fallback && fallback !== url;
    try { bmp = await fetchBitmap(url); } catch (e) { if (!useFallback) throw e; }
    if (useFallback && (!bmp || bmp.width < 300)) { bmp?.close(); bmp = await fetchBitmap(fallback); }
    const { width: w, height: h } = bmp;
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    return { w, h, data: ctx.getImageData(0, 0, w, h).data };
  }

  // Marge de `pad` pixels par réplication des bords.
  function padImage(img, pad) {
    const W = img.w + 2 * pad, H = img.h + 2 * pad;
    const out = new Uint8ClampedArray(W * H * 4);
    const src = img.data;
    for (let y = 0; y < H; y++) {
      const sy = Math.min(Math.max(y - pad, 0), img.h - 1);
      for (let x = 0; x < W; x++) {
        const sx = Math.min(Math.max(x - pad, 0), img.w - 1);
        const s = (sy * img.w + sx) * 4, d = (y * W + x) * 4;
        out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2]; out[d + 3] = 255;
      }
    }
    return { w: W, h: H, data: out };
  }

  /* ------------------------------------------------------------------ */
  /* Inférence par tuiles                                                */
  /* ------------------------------------------------------------------ */

  // Tuile de `tw × th` pixels prise en (px, py) dans l'image avec marge → tenseur CHW [0, 1].
  async function runTile(session, padded, px, py, tw, th) {
    const plane = tw * th;
    const input = new Float32Array(3 * plane);
    const src = padded.data;
    for (let y = 0; y < th; y++) {
      let s = ((py + y) * padded.w + px) * 4, o = y * tw;
      for (let x = 0; x < tw; x++, s += 4, o++) {
        input[o] = src[s] / 255;
        input[plane + o] = src[s + 1] / 255;
        input[2 * plane + o] = src[s + 2] / 255;
      }
    }
    const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, th, tw]) };
    const out = await session.run(feeds);
    return out[session.outputNames[0]];
  }

  // Copie le cœur d'une tuile (sans sa marge) dans l'image finale ×2,
  // en moyennant les blocs 2 × 2 de la sortie ×4.
  function blit(tensor, tw, th, cx, cy, cw, ch, dst, dstW) {
    const f = tensor.data;
    const OW = tw * MODEL_SCALE, OH = th * MODEL_SCALE, oplane = OW * OH;
    const off = PAD * MODEL_SCALE;
    for (let Y = 0; Y < ch * OUT_SCALE; Y++) {
      const r0 = (off + 2 * Y) * OW, r1 = r0 + OW;
      let d = ((cy * OUT_SCALE + Y) * dstW + cx * OUT_SCALE) * 4;
      for (let X = 0; X < cw * OUT_SCALE; X++, d += 4) {
        const c0 = off + 2 * X, c1 = c0 + 1;
        for (let c = 0; c < 3; c++) {
          const b = c * oplane;
          dst[d + c] = (f[b + r0 + c0] + f[b + r0 + c1] + f[b + r1 + c0] + f[b + r1 + c1]) * 63.75; // × 255 / 4
        }
        dst[d + 3] = 255;
      }
    }
  }

  async function superResolve(img) {
    const session = await getSession();
    const padded = padImage(img, PAD);
    const W = img.w * OUT_SCALE, H = img.h * OUT_SCALE;
    const rgba = new Uint8ClampedArray(W * H * 4);
    const tw = Math.min(cfg.TILE_W, img.w), th = Math.min(cfg.TILE_H, img.h);
    for (let cy = 0; cy < img.h; cy += th) {
      for (let cx = 0; cx < img.w; cx += tw) {
        const cw = Math.min(tw, img.w - cx), ch = Math.min(th, img.h - cy);
        // Dans l'image avec marge, l'origine (cx, cy) correspond à (cx − PAD, cy − PAD) dans l'originale.
        const out = await runTile(session, padded, cx, cy, cw + 2 * PAD, ch + 2 * PAD);
        blit(out, cw + 2 * PAD, ch + 2 * PAD, cx, cy, cw, ch, rgba, W);
        if (typeof out.dispose === 'function') out.dispose();
      }
    }
    return { rgba, W, H };
  }

  // Grain : hautes fréquences de l'originale étirée en ×2, ajoutées au résultat.
  function addGrain(img, rgba, W, H, g) {
    const lr = new OffscreenCanvas(img.w, img.h);
    lr.getContext('2d').putImageData(new ImageData(img.data, img.w, img.h), 0, 0);
    const layer = (blur) => {
      const c = new OffscreenCanvas(W, H);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingQuality = 'high';
      if (blur) ctx.filter = `blur(${blur}px)`;
      ctx.drawImage(lr, 0, 0, W, H);
      return ctx.getImageData(0, 0, W, H).data;
    };
    const sharp = layer(0), soft = layer(2);
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] += g * (sharp[i] - soft[i]);
      rgba[i + 1] += g * (sharp[i + 1] - soft[i + 1]);
      rgba[i + 2] += g * (sharp[i + 2] - soft[i + 2]);
    }
  }

  async function encode(rgba, W, H) {
    const canvas = new OffscreenCanvas(W, H);
    canvas.getContext('2d').putImageData(new ImageData(rgba, W, H), 0, 0);
    return canvas.convertToBlob({ type: 'image/webp', quality: WEBP_QUALITY });
  }

  function toDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Cache local                                                         */
  /* ------------------------------------------------------------------ */

  async function cacheGet(id) {
    try {
      const c = await caches.open(CACHE_NAME);
      const r = await c.match(CACHE_PREFIX + id);
      return r ? await r.blob() : null;
    } catch { return null; }
  }

  async function cachePut(id, blob) {
    try {
      const c = await caches.open(CACHE_NAME);
      await c.put(CACHE_PREFIX + id, new Response(blob, { headers: { 'content-type': 'image/webp' } }));
      const keys = await c.keys();
      for (const k of keys.slice(0, Math.max(0, keys.length - CACHE_MAX))) await c.delete(k);
    } catch { /* cache indisponible : on recalculera */ }
  }

  /* ------------------------------------------------------------------ */
  /* File d'attente                                                      */
  /* ------------------------------------------------------------------ */

  async function upscale(id, url, fallback) {
    const cached = await cacheGet(id);
    if (cached) return { blob: cached, cached: true };
    const img = await loadImage(url, fallback);
    const { rgba, W, H } = await superResolve(img);
    if (cfg.GRAIN > 0) addGrain(img, rgba, W, H, cfg.GRAIN);
    const blob = await encode(rgba, W, H);
    await cachePut(id, blob);
    return { blob, cached: false };
  }

  const pending = new Map(); // id → promesse de réponse
  const queue = [];
  let seq = 0;
  let running = false;

  // Une seule image à la fois : la plus prioritaire d'abord, puis la plus récente.
  function request({ id, url, fallback, priority = 0 }) {
    if (pending.has(id)) {
      const job = queue.find((j) => j.id === id);
      if (job && priority > job.priority) job.priority = priority;
      return pending.get(id);
    }
    const p = new Promise((resolve) => { queue.push({ id, url, fallback, priority, seq: seq++, resolve }); });
    pending.set(id, p);
    pump();
    return p;
  }

  async function pump() {
    if (running) return;
    running = true;
    while (queue.length) {
      queue.sort((a, b) => b.priority - a.priority || b.seq - a.seq);
      const job = queue.shift();
      const t0 = performance.now();
      try {
        const { blob, cached } = await upscale(job.id, job.url, job.fallback);
        job.resolve({ ok: true, dataUrl: await toDataUrl(blob), cached, ms: Math.round(performance.now() - t0) });
      } catch (e) {
        job.resolve({ ok: false, error: String((e && e.message) || e), fatal: !!fatal });
      } finally {
        pending.delete(job.id);
      }
    }
    running = false;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'ytc-hd') return;
    request(msg).then(sendResponse);
    return true;
  });

  // Pour les tests manuels depuis la console de ce document.
  self.__ytcHd = { cfg, upscale, request, getSession, superResolve, loadImage, encode, addGrain };
})();
