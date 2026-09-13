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

  function stylesheetNode() {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
      const url = chrome.runtime.getURL('gallery.css');
      const link = h('link', { rel: 'stylesheet', href: url });
      // Repli si la feuille est bloquée : on injecte le texte CSS dans un <style>.
      link.addEventListener('error', async () => {
        try { const css = await (await fetch(url)).text(); link.replaceWith(h('style', { text: css })); } catch (_) { /* ignore */ }
      });
      return link;
    }
    // Mode test (script injecté à la main) : CSS fourni dans window.__ytcCss
    return h('style', { text: window.__ytcCss || '' });
  }

  function openGallery() {
    if (state.open) return;
    state.open = true;
    state.view = 'grid';
    state.index = 0;
    state.videos = [];
    state.exhausted = false;
    state.loading = false;
    state.scrollYBefore = window.scrollY;
    state.lastBigIndex = -Infinity;
    state.lastBigSide = null;

    const info = channelInfo();
    const host = h('div', { id: HOST_ID });
    const root = host.attachShadow({ mode: 'open' });
    state.host = host;
    state.root = root;

    const bgA = h('div', { class: 'ytc-bg' });
    const bgB = h('div', { class: 'ytc-bg' });

    const segGrid = h('button', { type: 'button', class: 'is-active', text: 'Grille', onclick: () => setView('grid') });
    const segCinema = h('button', { type: 'button', text: 'Cinéma', onclick: () => setView('cinema') });

    const top = h('div', { class: 'ytc-top' },
      info.avatar ? h('img', { class: 'ytc-avatar', src: info.avatar, alt: '' }) : null,
      h('div', { class: 'ytc-heading' },
        h('div', { class: 'ytc-name', text: info.name }),
        h('div', { class: 'ytc-sub', text: info.meta || 'Mode contemplatif' }),
      ),
      h('div', { class: 'ytc-spacer' }),
      h('div', { class: 'ytc-seg' }, segGrid, segCinema),
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

    root.append(stylesheetNode(), wrap);
    document.documentElement.append(host);

    state.els = { wrap, bgA, bgB, top, grid, foot, spinner, moreBtn, footNote, cinema, stageImg, stageFrame, capTitle, capMeta, strip, segGrid, segCinema, cap };

    // Fond initial : bannière de la chaîne, puis première miniature.
    if (info.banner) setBackdrop(info.banner);

    appendVideos(collectVideos());
    if (!info.banner && state.videos[0]) setBackdrop(state.videos[0].fallback);

    document.addEventListener('keydown', onKeyDown, true);
    wrap.focus({ preventScroll: true });

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
    const { wrap } = state.els;
    wrap.classList.add('is-closing');
    const host = state.host;
    setTimeout(() => host.remove(), 450);
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
  function makeThumbImg(video, onReady) {
    const img = h('img', { alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('load', () => {
      // maxresdefault absent → YouTube renvoie un placeholder 120×90.
      if (img.naturalWidth < 300 && img.src !== video.fallback) { img.src = video.fallback; return; }
      video.loadedSrc = img.src;
      img.classList.add('is-loaded');
      onReady?.(img);
    });
    img.addEventListener('error', () => { if (img.src !== video.fallback) img.src = video.fallback; });
    img.src = video.src;
    return img;
  }

  function appendVideos(list) {
    if (!list.length) return;
    const { grid, strip } = state.els;
    const base = state.videos.length;
    const big = pickOutliers(list, base);
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      const idx = base + i;
      state.videos.push(v);
      v.big = big.has(v.id);
      const bigClass = v.big ? ' is-big' : '';

      const metaLine = [v.big ? 'Populaire' : '', v.duration, v.meta].filter(Boolean).join('  ·  ');
      const card = h('a', {
        class: 'ytc-card' + bigClass, href: v.href, style: `--i:${Math.min(i, 24)}`,
        onclick: (e) => onCardClick(e, v),
        onmouseenter: () => hoverBackdrop(v),
        oncontextmenu: (e) => { e.preventDefault(); state.index = idx; setView('cinema'); },
      },
        h('div', { class: 'ytc-thumb' },
          makeThumbImg(v),
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

  function playVideo(video) {
    if (!video) return;
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

  /* ------------------------------------------------------------------ */
  /* Cycle de vie (YouTube est une SPA)                                  */
  /* ------------------------------------------------------------------ */

  function onNavigate() {
    if (state.open) closeGallery();
    // La barre de filtres arrive parfois après l'événement de navigation.
    ensureButton();
    setTimeout(() => ensureButton(), 800);
    setTimeout(() => ensureButton(true), 3000);
  }

  document.addEventListener('yt-navigate-finish', onNavigate);
  window.addEventListener('popstate', () => setTimeout(() => ensureButton(), 500));

  // Filet de sécurité : YouTube re-rend parfois la barre de filtres.
  const mo = new MutationObserver(() => {
    if (isVideosTab() && !document.getElementById(BUTTON_ID)) ensureButton();
  });
  mo.observe(document.body, { childList: true, subtree: true });

  onNavigate();
})();
