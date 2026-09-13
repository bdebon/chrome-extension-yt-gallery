/* YouTube Contemplatif — script de contenu
 * Ajoute un bouton « Contempler » sur l'onglet Vidéos d'une chaîne et ouvre
 * une galerie plein écran. Pas d'innerHTML : YouTube impose Trusted Types.
 */
(() => {
  'use strict';
  if (window.__ytContemplatif) return;
  window.__ytContemplatif = true;

  const BUTTON_ID = 'ytc-open-button';
  const HOST_ID = 'ytc-host';

  const state = {
    open: false,
    view: 'grid', // 'grid' | 'cinema'
    videos: [],
    index: 0,
    loading: false,
    exhausted: false,
    scrollYBefore: 0,
    host: null,
    root: null,
    els: {},
    bgToggle: false,
    hoverTimer: null,
    lastBigIndex: -Infinity,
    lastBigSide: null,
    introDone: false,
    loadedCards: new Map(), // index → carte dont l'image est chargée, en attente de révélation
    revealPtr: 0,           // prochain index à révéler (ordre de la grille)
    nextRevealAt: 0,        // horloge de cascade
    stallTimer: null,
  };

  /* ------------------------------------------------------------------ */
  /* Utilitaires DOM                                                     */
  /* ------------------------------------------------------------------ */

  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function svg(pathD, attrs = {}) {
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', attrs.viewBox || '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', pathD);
    if (attrs.stroke) { p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round'); }
    s.append(p);
    return s;
  }

  const ICON_PLAY = 'M6 4l14 8-14 8z';
  const ICON_PREV = 'M15 5l-7 7 7 7';
  const ICON_NEXT = 'M9 5l7 7-7 7';

  function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function waitFor(pred, timeout = 5000, step = 150) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred()) return true;
      await wait(step);
    }
    return pred();
  }

  /* ------------------------------------------------------------------ */
  /* Lecture de la page YouTube                                          */
  /* ------------------------------------------------------------------ */

  function isVideosTab() {
    return /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/videos\/?$/.test(location.pathname);
  }

  function videoIdFromHref(href) {
    if (!href) return null;
    const m = href.match(/[?&]v=([\w-]{11})/) || href.match(/\/shorts\/([\w-]{11})/);
    return m ? m[1] : null;
  }

  function textOf(el) { return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; }

  // « 6,1 k vues », « 6.1k views », « 1,2 M de vues », « 12 345 vues » → nombre.
  function parseViews(text) {
    if (!text) return 0;
    const m = text.match(/([\d]+(?:[\s.,]\d+)*)\s*(k|K|M|Mio|Mrd|B|万|億)?/u);
    if (!m) return 0;
    let num = m[1].replace(/\s/gu, '');
    const hasDot = num.includes('.'), hasComma = num.includes(',');
    if (hasDot && hasComma) num = num.replace(/[.,]/g, (c, i, str) => (i === Math.max(str.lastIndexOf('.'), str.lastIndexOf(',')) ? '.' : ''));
    else if (hasDot || hasComma) {
      const sep = hasDot ? '.' : ',';
      const after = num.split(sep).pop();
      num = after.length === 3 && !m[2] ? num.replace(/[.,]/g, '') : num.replace(',', '.');
    }
    const n = parseFloat(num);
    if (!isFinite(n)) return 0;
    const mult = { k: 1e3, K: 1e3, M: 1e6, Mio: 1e6, Mrd: 1e9, B: 1e9, '万': 1e4, '億': 1e8 }[m[2]] || 1;
    return Math.round(n * mult);
  }

  // Les vidéos qui se démarquent du batch par leurs vues (≥ 1,5 × la médiane),
  // limitées à environ une sur huit. Si rien ne dépasse le seuil, la meilleure
  // est retenue dès qu'elle fait 1,25 × la médiane. Deux grandes cartes sont
  // toujours séparées d'au moins BIG_GAP - 1 vidéos, pour ne jamais se toucher.
  const BIG_GAP = 5;
  const BATCH = 30; // taille des batchs YouTube
  function pickOutliers(list, base) {
    const withViews = list.map((v, i) => ({ v, i: base + i })).filter((x) => x.v.views > 0);
    if (withViews.length < 6) return new Set();
    const sorted = withViews.map((x) => x.v.views).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const limit = Math.max(1, Math.ceil(list.length / 8));
    const ranked = withViews.slice().sort((a, b) => b.v.views - a.v.views);
    let pool = ranked.filter((x) => x.v.views >= median * 1.5);
    if (!pool.length && ranked[0].v.views >= median * 1.25) pool = [ranked[0]];

    const taken = [];
    for (const x of pool) {
      if (taken.length >= limit) break;
      if (x.i - state.lastBigIndex < BIG_GAP) continue;
      if (taken.some((t) => Math.abs(t.i - x.i) < BIG_GAP)) continue;
      taken.push(x);
    }
    if (taken.length) state.lastBigIndex = Math.max(state.lastBigIndex, ...taken.map((t) => t.i));
    return new Set(taken.map((t) => t.v.id));
  }

  function collectVideos() {
    const seen = new Set(state.videos.map((v) => v.id));
    const found = [];
    const items = document.querySelectorAll('ytd-rich-item-renderer');
    for (const item of items) {
      const anchors = [...item.querySelectorAll('a[href*="/watch?v="], a[href*="/shorts/"]')];
      if (!anchors.length) continue;
      const id = videoIdFromHref(anchors[0].getAttribute('href'));
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const titleEl =
        item.querySelector('a.ytLockupMetadataViewModelTitle, #video-title-link, #video-title, h3 a, h3') || anchors[anchors.length - 1];
      const title = textOf(titleEl) || titleEl?.getAttribute('title') || titleEl?.getAttribute('aria-label') || 'Sans titre';

      const durationEl = item.querySelector(
        '.ytBadgeShapeText, badge-shape div, ytd-thumbnail-overlay-time-status-renderer span, .badge-shape-wiz__text'
      );
      const duration = textOf(durationEl);

      const metaSpans = [...item.querySelectorAll(
        '.ytContentMetadataViewModelMetadataText, #metadata-line span, .inline-metadata-item'
      )].map(textOf).filter(Boolean);
      const meta = metaSpans.join(' · ');
      const viewsText = metaSpans.find((t) => /vue|view|visual|aufruf|visualiz|weergav|visning|wyświetl|просмотр|回視聴|次观看|조회/i.test(t)) || metaSpans[0] || '';
      const views = parseViews(viewsText);

      found.push({
        id,
        title,
        duration,
        meta,
        views,
        href: anchors[0].getAttribute('href'),
        anchor: titleEl && titleEl.tagName === 'A' ? titleEl : anchors[0],
        src: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
        fallback: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      });
    }
    return found;
  }

  function hasContinuation() {
    return !!document.querySelector('ytd-rich-grid-renderer ytd-continuation-item-renderer');
  }

  function channelInfo() {
    const header = document.querySelector('yt-page-header-renderer, #page-header');
    const name = textOf(header?.querySelector('h1')) || document.title.replace(/\s*-\s*YouTube\s*$/, '');
    const avatar = header?.querySelector('img')?.src || '';
    const banner = document.querySelector('[class*="Banner"] img, [class*="banner"] img')?.src || '';
    const metaTexts = [...(header?.querySelectorAll('.ytContentMetadataViewModelMetadataText') || [])]
      .map(textOf).filter((t) => t && !t.startsWith('@'));
    return { name, avatar, banner, meta: metaTexts.join(' · ') };
  }

  /* ------------------------------------------------------------------ */
  /* Bouton d'entrée                                                     */
  /* ------------------------------------------------------------------ */

  // Reproduit le balisage et les classes des chips YouTube (« Les plus récentes »…)
  // pour hériter exactement de leur style, thème clair comme sombre.
  function makeOpenButton() {
    const feedback = h('yt-touch-feedback-shape', {
      'aria-hidden': 'true',
      class: 'ytSpecTouchFeedbackShapeHost ytSpecTouchFeedbackShapeTouchResponse ytSpecTouchFeedbackShapeTriggerEvents',
    },
      h('div', { class: 'ytSpecTouchFeedbackShapeStroke', style: 'border-radius:8px' }),
      h('div', { class: 'ytSpecTouchFeedbackShapeFill', style: 'border-radius:8px' }),
    );
    const chip = h('div', { class: 'ytChipShapeChip ytChipShapeInactive ytChipShapeOnlyTextPadding' },
      h('div', { text: 'Contempler' }), feedback);
    const btn = h('button', {
      type: 'button', class: 'ytChipShapeButtonReset', role: 'tab', 'aria-label': 'Contempler',
      title: 'Ouvrir la galerie contemplative',
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); openGallery(); },
    }, chip);
    return h('div', { id: BUTTON_ID, class: 'ytChipBarViewModelChipWrapper', role: 'presentation' }, btn);
  }

  function findChipBar() {
    return document.querySelector(
      'ytd-rich-grid-renderer chip-bar-view-model .ytChipBarViewModelChipBarScrollContainer, ' +
      'ytd-rich-grid-renderer #chips-wrapper, ytd-feed-filter-chip-bar-renderer #chips-wrapper'
    );
  }

  // allowFallback : autorise un bouton flottant si la barre de filtres est introuvable.
  function ensureButton(allowFallback = false) {
    const existing = document.getElementById(BUTTON_ID);
    if (!isVideosTab()) { existing?.remove(); return; }
    const chipBar = findChipBar();
    if (existing && existing.isConnected) {
      if (existing.dataset.placement === 'floating' && chipBar) existing.remove();
      else return;
    }
    if (!chipBar && !allowFallback) return;

    const btn = makeOpenButton();
    if (chipBar) {
      btn.dataset.placement = 'inline';
      chipBar.append(btn);
    } else {
      btn.dataset.placement = 'floating';
      btn.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:9999;';
      document.body.append(btn);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Galerie                                                             */
  /* ------------------------------------------------------------------ */

  // La feuille de style est chargée dès le départ et injectée en <style> :
  // avec un <link>, la galerie se peignait une fraction de seconde sans style.
  let cssPromise = null;
  function loadCss() {
    if (cssPromise) return cssPromise;
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
      cssPromise = fetch(chrome.runtime.getURL('gallery.css')).then((r) => r.text()).catch(() => '');
    } else {
      cssPromise = Promise.resolve(window.__ytcCss || ''); // mode test
    }
    return cssPromise;
  }

  async function openGallery(resume = null) {
    if (state.open) return;
    const css = await loadCss();
    if (state.open) return;
    if (!resume) clearResume();
    state.resuming = !!resume;
    state.open = true;
    state.view = 'grid';
    state.index = 0;
    state.videos = [];
    state.exhausted = false;
    state.loading = false;
    state.scrollYBefore = window.scrollY;
    state.lastBigIndex = -Infinity;
    state.lastBigSide = null;
    state.introDone = false;
    state.loadedCards = new Map();
    state.revealPtr = 0;
    state.nextRevealAt = 0;
    clearTimeout(state.stallTimer);

    const info = channelInfo();
    const host = h('div', { id: HOST_ID });
    const root = host.attachShadow({ mode: 'open' });
    state.host = host;
    state.root = root;

    const bgA = h('div', { class: 'ytc-bg' });
    const bgB = h('div', { class: 'ytc-bg' });

    const segGrid = h('button', { type: 'button', class: 'is-active', text: 'Grille', onclick: () => setView('grid') });
    const segCinema = h('button', { type: 'button', text: 'Cinéma', onclick: () => setView('cinema') });
    const seg = h('div', { class: 'ytc-seg' }, segGrid, segCinema);

    const top = h('div', { class: 'ytc-top' },
      info.avatar ? h('img', { class: 'ytc-avatar', src: info.avatar, alt: '' }) : null,
      h('div', { class: 'ytc-heading' },
        h('div', { class: 'ytc-name', text: info.name }),
        h('div', { class: 'ytc-sub', text: info.meta || 'Mode contemplatif' }),
      ),
      h('div', { class: 'ytc-spacer' }),
      seg,
      h('button', { type: 'button', class: 'ytc-close', onclick: closeGallery },
        h('span', { text: 'Quitter' }), h('span', { class: 'ytc-kbd', text: 'Échap' })),
    );

    const grid = h('div', { class: 'ytc-grid' });
    const spinner = h('div', { class: 'ytc-spinner ytc-hidden' });
    const moreBtn = h('button', { type: 'button', class: 'ytc-btn', text: 'Charger la suite', onclick: () => loadMore() });
    const footNote = h('span', { class: 'ytc-hidden', text: 'Fin de la chaîne' });
    const foot = h('div', { class: 'ytc-foot' }, spinner, moreBtn, footNote);

    // Cinéma
    const stageImg = h('img', { alt: '' });
    const stageFrame = h('div', { class: 'ytc-stage-frame', onclick: () => playVideo(state.videos[state.index]) },
      stageImg,
      h('div', { class: 'ytc-play' }, h('span', {}, svg(ICON_PLAY), 'Regarder')),
    );
    const prevBtn = h('button', { type: 'button', class: 'ytc-arrow is-prev', 'aria-label': 'Précédente', onclick: () => step(-1) }, svg(ICON_PREV, { stroke: true }));
    const nextBtn = h('button', { type: 'button', class: 'ytc-arrow is-next', 'aria-label': 'Suivante', onclick: () => step(1) }, svg(ICON_NEXT, { stroke: true }));
    const capTitle = h('div', { class: 'ytc-cap-title' });
    const capMeta = h('div', { class: 'ytc-cap-meta' });
    const cap = h('div', { class: 'ytc-cap' }, capTitle, capMeta);
    const strip = h('div', { class: 'ytc-strip' });
    const cinema = h('div', { class: 'ytc-cinema ytc-hidden' },
      h('div', { class: 'ytc-stage' }, prevBtn, stageFrame, nextBtn),
      cap, strip,
    );

    const wrap = h('div', { class: 'ytc', tabindex: '-1' },
      bgA, bgB, h('div', { class: 'ytc-veil' }), h('div', { class: 'ytc-grain' }),
      top, grid, foot, cinema,
    );

    // Rideau noir qui se ferme en fondu (350 ms) ; rien d'autre n'est visible
    // pendant ce temps, les cartes et l'en-tête n'arrivent qu'après.
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:#0b0b0d;opacity:0;transition:opacity .35s ease';
    if (resume) { wrap.classList.add('is-resume'); host.style.transition = 'none'; host.style.opacity = '1'; }
    root.append(h('style', { text: css }), wrap);
    document.documentElement.append(host);
    state.openedAt = performance.now();
    if (!resume) requestAnimationFrame(() => requestAnimationFrame(() => { host.style.opacity = '1'; }));

    state.els = { wrap, bgA, bgB, top, grid, foot, spinner, moreBtn, footNote, cinema, stageImg, stageFrame, capTitle, capMeta, strip, seg, segGrid, segCinema, cap };

    appendVideos(collectVideos());

    // Entrée en scène : rideau noir immédiat, puis le fond ambiant s'allume
    // (double rAF pour que la transition d'opacité soit bien jouée).
    const firstBg = info.banner || state.videos[0]?.fallback;
    if (firstBg && resume) {
      // Fond posé sans transition, puis les fondus croisés reprennent au survol.
      for (const bg of [bgA, bgB]) bg.style.transition = 'none';
      setBackdrop(firstBg);
      setTimeout(() => { for (const bg of [bgA, bgB]) bg.style.transition = ''; }, 100);
    } else if (firstBg) {
      requestAnimationFrame(() => requestAnimationFrame(() => { if (state.open) setBackdrop(firstBg); }));
    }
    // Les cartes du premier écran apparaissent ensemble, en cascade, dès que
    // leurs images sont là (ou après 1,8 s au plus tard).
    setTimeout(finishIntro, INTRO_TIMEOUT);
    if (resume) restorePosition(resume);

    document.addEventListener('keydown', onKeyDown, true);
    wrap.focus({ preventScroll: true });
    loadCss(); // précharge pour les ouvertures suivantes
    showUpdateBadge();

    // Chargement automatique en approchant du bas.
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && state.view === 'grid') loadMore();
    }, { root: wrap, rootMargin: '800px 0px' });
    io.observe(foot);
    state.io = io;
  }

  function closeGallery() {
    if (!state.open) return;
    state.open = false;
    document.removeEventListener('keydown', onKeyDown, true);
    state.io?.disconnect();
    clearTimeout(state.stallTimer);
    const { wrap } = state.els;
    wrap.classList.add('is-closing');
    const host = state.host;
    // Sortie symétrique : le contenu s'éteint, puis le rideau s'ouvre en fondu.
    setTimeout(() => { host.style.transition = 'opacity .35s ease'; host.style.opacity = '0'; }, 200);
    setTimeout(() => host.remove(), 560);
    window.scrollTo({ top: state.scrollYBefore, behavior: 'instant' });
    state.host = null; state.root = null; state.els = {};
  }

  function setView(view) {
    if (!state.open) return;
    state.view = view;
    const { grid, foot, cinema, segGrid, segCinema, wrap } = state.els;
    const isCinema = view === 'cinema';
    grid.classList.toggle('ytc-hidden', isCinema);
    foot.classList.toggle('ytc-hidden', isCinema);
    cinema.classList.toggle('ytc-hidden', !isCinema);
    segGrid.classList.toggle('is-active', !isCinema);
    segCinema.classList.toggle('is-active', isCinema);
    wrap.style.overflowY = isCinema ? 'hidden' : 'auto';
    if (isCinema) showIndex(state.index);
  }

  /* --- fond ambiant --- */
  function setBackdrop(url) {
    const { bgA, bgB } = state.els;
    if (!bgA) return;
    const incoming = state.bgToggle ? bgA : bgB;
    const outgoing = state.bgToggle ? bgB : bgA;
    state.bgToggle = !state.bgToggle;
    if (incoming.dataset.url === url) { incoming.classList.add('is-on'); outgoing.classList.remove('is-on'); return; }
    incoming.dataset.url = url;
    incoming.style.backgroundImage = `url("${url}")`;
    incoming.classList.add('is-on');
    outgoing.classList.remove('is-on');
  }

  function hoverBackdrop(video) {
    clearTimeout(state.hoverTimer);
    state.hoverTimer = setTimeout(() => setBackdrop(video.loadedSrc || video.fallback), 180);
  }

  /* --- grille --- */
  function makeThumbImg(video, onReady, eager = false) {
    const img = h('img', { alt: '', loading: eager ? 'eager' : 'lazy', decoding: 'async' });
    img.addEventListener('load', () => {
      // maxresdefault absent → YouTube renvoie un placeholder 120×90.
      if (img.naturalWidth < 300 && img.src !== video.fallback) { img.src = video.fallback; return; }
      video.loadedSrc = img.src;
      img.classList.add('is-loaded');
      onReady?.(img);
    });
    img.addEventListener('error', () => {
      if (img.src !== video.fallback) img.src = video.fallback;
      else onReady?.(img); // image introuvable : on montre quand même la carte
    });
    img.src = video.src;
    return img;
  }

  /* --- entrée en scène --- */
  // Une seule horloge révèle les cartes dans l'ordre de la grille, une par
  // une, quelle que soit la vitesse de chargement des images.
  const INTRO_COUNT = 12;   // cartes du premier écran attendues avant de démarrer
  const INTRO_TIMEOUT = 1800;
  const REVEAL_STEP = 55;   // ms entre deux cartes
  const STALL_TIMEOUT = 1200; // au-delà, on saute une image qui traîne

  function revealCard(card, delay, instant = false) {
    card.style.setProperty('--d', String(Math.round(delay)));
    card.classList.add('is-ready');
    if (instant) card.classList.add('is-instant');
  }

  function scheduleReveal(card) {
    const now = performance.now();
    const at = Math.max(now, state.nextRevealAt);
    state.nextRevealAt = at + REVEAL_STEP;
    revealCard(card, at - now);
  }

  function onCardReady(card, index) {
    if (!state.open) return;
    if (state.resuming) { revealCard(card, 0, true); return; }
    if (index < state.revealPtr) { scheduleReveal(card); return; } // sautée plus tôt, elle arrive enfin
    state.loadedCards.set(index, card);
    pumpReveals();
  }

  function finishIntro() {
    if (!state.open || state.introDone) return;
    state.introDone = true;
    // Jamais avant la fin du rideau : au moins 650 ms après l'ouverture.
    state.nextRevealAt = Math.max(performance.now() + 250, state.openedAt + 650);
    pumpReveals();
  }

  function pumpReveals() {
    if (!state.open) return;
    if (!state.introDone) {
      if (state.loadedCards.size >= Math.min(INTRO_COUNT, state.videos.length)) finishIntro();
      return;
    }
    while (state.loadedCards.has(state.revealPtr)) {
      scheduleReveal(state.loadedCards.get(state.revealPtr));
      state.loadedCards.delete(state.revealPtr);
      state.revealPtr++;
    }
    // Garde-fou : si des cartes plus loin sont prêtes mais qu'une image traîne,
    // on saute cette dernière au bout d'un moment (elle apparaîtra à son arrivée).
    clearTimeout(state.stallTimer);
    if (state.loadedCards.size) {
      state.stallTimer = setTimeout(() => {
        if (!state.open || !state.loadedCards.size) return;
        state.revealPtr = Math.min(...state.loadedCards.keys());
        pumpReveals();
      }, STALL_TIMEOUT);
    }
  }

  function appendVideos(list) {
    if (!list.length) return;
    const { grid, strip } = state.els;
    const base = state.videos.length;
    // Sélection des « populaires » par tranches de 30, comme les batchs de
    // YouTube : le résultat ne dépend pas du nombre de vidéos déjà en page.
    const big = new Set();
    for (let c = 0; c < list.length; c += BATCH) {
      for (const id of pickOutliers(list.slice(c, c + BATCH), base + c)) big.add(id);
    }
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      const idx = base + i;
      state.videos.push(v);
      v.big = big.has(v.id);
      const bigClass = v.big ? ' is-big' : '';

      const metaLine = [v.big ? 'Populaire' : '', v.duration, v.meta].filter(Boolean).join('  ·  ');
      const card = h('a', {
        class: 'ytc-card' + bigClass, href: v.href, dataset: { index: String(idx) },
        onclick: (e) => onCardClick(e, v),
        onmouseenter: () => hoverBackdrop(v),
        oncontextmenu: (e) => { e.preventDefault(); state.index = idx; setView('cinema'); },
      },
        h('div', { class: 'ytc-thumb' },
          makeThumbImg(v, () => onCardReady(card, idx), base === 0),
          h('div', { class: 'ytc-caption' },
            h('div', { class: 'ytc-title', text: v.title }),
            metaLine ? h('div', { class: 'ytc-meta', text: metaLine }) : null,
          ),
        ),
      );
      grid.append(card);

      const thumb = h('button', { type: 'button', class: 'ytc-strip-item', title: v.title, onclick: () => showIndex(idx) },
        h('img', { alt: '', loading: 'lazy', src: `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg` }));
      strip.append(thumb);
    }
    alternateBigSides(base);
    updateFoot();
  }

  // Après mise en page, deux grandes cartes consécutives ne doivent pas être
  // du même côté (sinon elles s'empilent verticalement). On lit le côté réel
  // de chacune et on force la suivante du côté opposé.
  function alternateBigSides(fromIndex) {
    const { grid } = state.els;
    const gridRect = grid.getBoundingClientRect();
    if (!gridRect.width) return; // grille masquée (mode Cinéma) : rien à mesurer
    const cards = [...grid.children].slice(fromIndex).filter((c) => c.classList.contains('is-big'));
    const mid = gridRect.left + gridRect.width / 2;
    for (const card of cards) {
      const r = card.getBoundingClientRect();
      let side = r.left + r.width / 2 < mid ? 'left' : 'right';
      if (side === state.lastBigSide) {
        side = side === 'left' ? 'right' : 'left';
        card.classList.add(side === 'left' ? 'is-left' : 'is-right');
      }
      state.lastBigSide = side;
    }
  }

  function onCardClick(e, video) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return; // nouvel onglet : comportement natif
    e.preventDefault();
    playVideo(video);
  }

  const RESUME_KEY = 'ytc-resume';
  function saveResume(video) {
    try {
      sessionStorage.setItem(RESUME_KEY, JSON.stringify({
        path: location.pathname,
        videoId: video?.id || null,
        scrollTop: state.els.wrap?.scrollTop || 0,
        view: state.view,
        index: state.index,
        count: state.videos.length,
        ts: Date.now(),
      }));
    } catch (_) { /* stockage indisponible */ }
  }
  function readResume() {
    try {
      const r = JSON.parse(sessionStorage.getItem(RESUME_KEY) || 'null');
      return r && r.path === location.pathname && Date.now() - r.ts < 6 * 3600e3 ? r : null;
    } catch (_) { return null; }
  }
  function clearResume() { try { sessionStorage.removeItem(RESUME_KEY); } catch (_) { /* ignore */ } }

  function playVideo(video) {
    if (!video) return;
    saveResume(video); // pour rouvrir la galerie au même endroit après un retour arrière
    closeGallery();
    // Réutilise le lien d'origine pour profiter de la navigation SPA de YouTube.
    if (video.anchor?.isConnected) video.anchor.click();
    else location.href = video.href;
  }

  /* --- chargement --- */
  function updateFoot() {
    const { spinner, moreBtn, footNote } = state.els;
    spinner.classList.toggle('ytc-hidden', !state.loading);
    moreBtn.classList.toggle('ytc-hidden', state.loading || state.exhausted);
    footNote.classList.toggle('ytc-hidden', !state.exhausted);
  }

  async function loadMore() {
    if (!state.open || state.loading || state.exhausted) return;
    if (!hasContinuation()) { state.exhausted = true; updateFoot(); return; }
    state.loading = true; updateFoot();

    const before = document.querySelectorAll('ytd-rich-item-renderer').length;
    for (let attempt = 0; attempt < 3; attempt++) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      const grew = await waitFor(() => document.querySelectorAll('ytd-rich-item-renderer').length > before, 4000);
      if (grew) break;
      if (!hasContinuation()) break;
    }
    const fresh = state.open ? collectVideos() : [];
    if (!fresh.length && !hasContinuation()) state.exhausted = true;
    state.loading = false;
    if (state.open) { appendVideos(fresh); updateFoot(); }
  }

  /* --- cinéma --- */
  function showIndex(i) {
    const n = state.videos.length;
    if (!n) return;
    state.index = ((i % n) + n) % n;
    const v = state.videos[state.index];
    const { stageImg, capTitle, capMeta, strip, cap } = state.els;

    stageImg.classList.remove('is-loaded');
    const onload = () => {
      if (stageImg.naturalWidth < 300 && stageImg.src !== v.fallback) { stageImg.src = v.fallback; return; }
      v.loadedSrc = stageImg.src;
      stageImg.classList.add('is-loaded');
      stageImg.removeEventListener('load', onload);
    };
    stageImg.addEventListener('load', onload);
    stageImg.src = v.loadedSrc || v.src;

    capTitle.textContent = v.title;
    capMeta.textContent = [v.duration, v.meta].filter(Boolean).join('  ·  ');
    cap.style.animation = 'none'; void cap.offsetWidth; cap.style.animation = '';

    setBackdrop(v.loadedSrc || v.fallback);

    [...strip.children].forEach((el, k) => el.classList.toggle('is-active', k === state.index));
    strip.children[state.index]?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });

    // Précharge les voisines et charge la suite en fin de liste.
    for (const d of [1, -1]) { const nv = state.videos[state.index + d]; if (nv) new Image().src = nv.src; }
    if (state.index >= n - 3) loadMore();
  }

  function step(d) { showIndex(state.index + d); }

  /* --- clavier --- */
  function onKeyDown(e) {
    if (!state.open) return;
    const cinema = state.view === 'cinema';
    switch (e.key) {
      case 'Escape':
        e.preventDefault(); e.stopPropagation();
        if (cinema) setView('grid'); else closeGallery();
        break;
      case 'ArrowLeft': if (cinema) { e.preventDefault(); e.stopPropagation(); step(-1); } break;
      case 'ArrowRight': if (cinema) { e.preventDefault(); e.stopPropagation(); step(1); } break;
      case 'Enter': if (cinema) { e.preventDefault(); e.stopPropagation(); playVideo(state.videos[state.index]); } break;
      case 'c': case 'C': e.preventDefault(); e.stopPropagation(); setView(cinema ? 'grid' : 'cinema'); break;
      default: return;
    }
  }

  /* --- update check --- */
  // Unpacked extensions never auto-update: once per 6 hours, ask GitHub for the
  // latest release and show a discreet badge in the header when it is newer.
  const REPO = 'bdebon/chrome-extension-yt-gallery';
  const UPDATE_KEY = 'ytc-update-check';
  const UPDATE_TTL = 6 * 3600e3;

  function currentVersion() {
    try { return chrome.runtime.getManifest().version; } catch (_) { return null; }
  }

  // Returns > 0 when a is newer than b. Accepts "v1.2.3" or "1.2.3".
  function compareVersions(a, b) {
    const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
    return 0;
  }

  async function fetchLatestRelease() {
    try {
      const cached = JSON.parse(localStorage.getItem(UPDATE_KEY) || 'null');
      if (cached && Date.now() - cached.ts < UPDATE_TTL) return cached;
    } catch (_) { /* storage unavailable */ }
    let info = { tag: null, url: null, ts: Date.now() };
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
      if (r.ok) { const j = await r.json(); info = { tag: j.tag_name || null, url: j.html_url || null, ts: Date.now() }; }
    } catch (_) { /* offline, rate-limited… try again later */ }
    try { localStorage.setItem(UPDATE_KEY, JSON.stringify(info)); } catch (_) { /* ignore */ }
    return info;
  }

  async function showUpdateBadge() {
    const mine = currentVersion();
    if (!mine) return;
    const latest = await fetchLatestRelease();
    if (!latest?.tag || !state.open || compareVersions(latest.tag, mine) <= 0) return;
    const badge = h('a', {
      class: 'ytc-update', href: latest.url || `https://github.com/${REPO}/releases`, target: '_blank', rel: 'noopener',
      title: `Version installée : ${mine}. Cliquer pour télécharger la nouvelle version.`,
    }, h('span', { class: 'ytc-update-dot' }), h('span', { text: `${latest.tag} disponible` }));
    state.els.top.insertBefore(badge, state.els.seg);
  }

  /* --- reprise après retour arrière --- */
  async function restorePosition(resume) {
    // Recharge la suite jusqu'à retrouver autant de vidéos qu'avant.
    for (let guard = 0; guard < 20 && state.open && state.videos.length < resume.count && !state.exhausted; guard++) {
      await loadMore();
    }
    if (!state.open) return;
    if (resume.view === 'cinema') {
      state.index = Math.min(resume.index, state.videos.length - 1);
      setView('cinema');
    } else {
      state.els.wrap.scrollTop = resume.scrollTop;
    }
    clearResume();
    // Repasse en mode normal (cascade) pour les chargements suivants.
    setTimeout(() => { state.resuming = false; state.introDone = true; state.revealPtr = state.videos.length; }, 1500);
  }

  async function maybeResume() {
    const resume = readResume();
    if (!resume || state.open || !isVideosTab()) return;
    const ok = await waitFor(() => document.querySelector('ytd-rich-item-renderer a[href*="/watch?v="]'), 5000);
    if (!ok || state.open || !isVideosTab()) return;
    openGallery(resume);
  }

  /* ------------------------------------------------------------------ */
  /* Cycle de vie (YouTube est une SPA)                                  */
  /* ------------------------------------------------------------------ */

  // Chemin de la page précédente (YouTube est une SPA, on suit les navigations).
  let prevHref = location.href;

  function onNavigate() {
    const from = prevHref;
    prevHref = location.href;
    const changed = from !== location.href;
    // YouTube émet parfois plusieurs yt-navigate-finish pour une même page :
    // on ne ferme la galerie que si l'URL a réellement changé.
    if (state.open && changed) closeGallery();
    // La barre de filtres arrive parfois après l'événement de navigation.
    ensureButton();
    setTimeout(() => ensureButton(), 800);
    setTimeout(() => ensureButton(true), 3000);
    // Retour sur l'onglet Vidéos depuis la page de lecture de la vidéo lancée
    // dans la galerie : on la rouvre au même endroit, sans animation.
    if (isVideosTab() && changed) {
      const resume = readResume();
      const fromId = (from.match(/[?&]v=([\w-]{11})/) || [])[1];
      if (resume && fromId && fromId === resume.videoId) maybeResume();
    }
  }

  document.addEventListener('yt-navigate-finish', onNavigate);
  window.addEventListener('popstate', () => setTimeout(() => ensureButton(), 500));

  // Filet de sécurité : YouTube re-rend parfois la barre de filtres.
  const mo = new MutationObserver(() => {
    if (isVideosTab() && !document.getElementById(BUTTON_ID)) ensureButton();
  });
  mo.observe(document.body, { childList: true, subtree: true });

  onNavigate();
  if (isVideosTab()) loadCss();
  // Chargement complet de la page via le bouton Précédent du navigateur.
  if (performance.getEntriesByType('navigation')[0]?.type === 'back_forward' && readResume()) maybeResume();
})();
