// Watch Later Toggle - runs in the page's MAIN world so it can read
// window.ytcfg and call YouTube's InnerTube API with the page's own session.
(() => {
  'use strict';

  const ORIGIN = 'https://www.youtube.com';
  const WRAP_ID = 'wl-toggle-wrap';
  const BTN_ID = 'wl-toggle-btn';
  const LINKS_ID = 'wl-toggle-links';
  const CARD_BTN_ID = 'wl-card-btn';

  // Inset from the thumbnail's top-left corner. Top-left is the only free
  // corner: YouTube puts mute and captions top-right, the duration badge
  // bottom-right, and its own hover clock top-right on the layouts that have one.
  const CARD_INSET = 8;
  // Floor for what counts as a thumbnail. YouTube's smallest real one is about
  // 100x56 in the compact sidebar, and nothing legitimate is under this.
  const CARD_MIN_W = 80;
  const CARD_MIN_H = 45;

  const LINK_PLAYLIST = { href: 'https://www.youtube.com/playlist?list=WL', text: 'Playlist' };
  const LINK_SUBS = { href: 'https://www.youtube.com/feed/subscriptions', text: 'Subscriptions' };

  // The three pages with a bespoke widget, plus the catch-all everywhere else.
  const WATCH = 'watch';
  const SUBS = 'subs';
  const WL_PAGE = 'wl';
  const OTHER = 'other';

  // Watch Later can be long, so the id set is cached rather than re-listed on
  // every SPA navigation; toggles patch the cache so it stays correct in between.
  const WL_CACHE_TTL = 5 * 60 * 1000;
  // Raised from 20 when the card buttons landed. One wrong 'not saved' on a
  // watch page is a single button; across a grid of forty cards it is obvious.
  const WL_MAX_PAGES = 50; // ~5000 videos, then we stop paging

  let inFlight = false;
  let refreshSeq = 0;
  let wlIds = null;
  let wlIdsAt = 0;
  let wlIdsPromise = null;

  // The card button that follows the pointer, and what it is currently showing.
  let cardAnchor = null;
  let cardVideoId = null;
  let cardSeq = 0;
  let cardFrame = 0;

  // ---------- helpers ----------

  const getVideoId = () =>
    location.pathname === '/watch'
      ? new URLSearchParams(location.search).get('v')
      : null;

  const getPage = () => {
    if (location.pathname === '/watch') return WATCH;
    if (location.pathname === '/feed/subscriptions') return SUBS;
    // Only the Watch Later playlist itself - other playlists get no widget.
    if (location.pathname === '/playlist' &&
        new URLSearchParams(location.search).get('list') === 'WL') return WL_PAGE;
    // The one page that still gets nothing: a fixed-position widget pinned
    // inside a small embedded player on somebody else's site is intrusive, and
    // neither link is any use from there anyway.
    if (location.pathname.startsWith('/embed/')) return null;
    return OTHER;
  };

  const cfg = (key) =>
    window.ytcfg && typeof window.ytcfg.get === 'function'
      ? window.ytcfg.get(key)
      : undefined;

  const getSapisid = () => {
    const m = document.cookie.match(/(?:^|;\s*)(?:SAPISID|__Secure-3PAPISID)=([^;\s]+)/);
    return m ? m[1] : null;
  };

  const sha1Hex = async (str) => {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  };

  const authHeader = async () => {
    const sapisid = getSapisid();
    if (!sapisid) return null;
    const time = Math.floor(Date.now() / 1000);
    const hash = await sha1Hex(`${time} ${sapisid} ${ORIGIN}`);
    return `SAPISIDHASH ${time}_${hash}`;
  };

  // ---------- InnerTube ----------

  const innertube = async (endpoint, body) => {
    const key = cfg('INNERTUBE_API_KEY');
    const context = cfg('INNERTUBE_CONTEXT');
    const auth = await authHeader();
    if (!key || !context || !auth) throw new Error('No YouTube session available');

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': auth,
      'X-Origin': ORIGIN,
      'X-Goog-AuthUser': String(cfg('SESSION_INDEX') || '0'),
    };
    // Brand/channel accounts: without this, InnerTube answers for the primary
    // Google account, whose Watch Later is a different playlist entirely.
    const pageId = cfg('DELEGATED_SESSION_ID');
    if (pageId) headers['X-Goog-PageId'] = pageId;

    const res = await fetch(`${ORIGIN}/youtubei/v1/${endpoint}?key=${key}&prettyPrint=false`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ context, ...body }),
    });
    if (!res.ok) throw new Error(`${endpoint} -> HTTP ${res.status}`);
    return res.json();
  };

  // Membership has to come from listing WL itself. The obvious candidate,
  // playlist/get_add_to_playlist, is a dead end: it reports Watch Later under a
  // per-account playlist id rather than the 'WL' alias, and - the reason it is
  // unusable - its containsSelectedVideos is always 'NONE' for WL, even for
  // videos demonstrably in the playlist. Reading it gave a button that could
  // never show the "already saved" state.
  const listWatchLaterIds = async () => {
    const ids = new Set();
    let token = null;

    for (let page = 0; page < WL_MAX_PAGES; page++) {
      const data = await innertube('browse', token ? { continuation: token } : { browseId: 'VLWL' });
      token = null;
      (function walk(node) {
        if (!node || typeof node !== 'object') return;
        const vid = node.playlistVideoRenderer?.videoId;
        if (vid) ids.add(vid);
        const next = node.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
        if (next) token = next;
        for (const key in node) walk(node[key]);
      })(data);
      if (!token) break;
    }
    // Stopping with a continuation token still outstanding means the set is
    // incomplete, so 'not in the set' no longer means 'not in Watch Later'.
    // Say so in the console rather than silently mislabelling buttons.
    if (token) {
      console.warn(
        `[wl-toggle] stopped listing Watch Later at ${WL_MAX_PAGES} pages (${ids.size} videos);`,
        'anything past that will show as not saved',
      );
    }
    return ids;
  };

  const watchLaterIds = () => {
    if (wlIds && Date.now() - wlIdsAt < WL_CACHE_TTL) return Promise.resolve(wlIds);
    if (!wlIdsPromise) {
      wlIdsPromise = listWatchLaterIds()
        .then((ids) => {
          wlIds = ids;
          wlIdsAt = Date.now();
          // The brand-account id is what makes this log useful when the wrong
          // Watch Later comes back, but it is also an account identifier on
          // screen in any console screenshot, so log only whether one is in
          // play rather than its value.
          console.debug(
            `[wl-toggle] listed ${ids.size} Watch Later videos`,
            `authuser=${cfg('SESSION_INDEX') || '0'}`,
            `brandAccount=${cfg('DELEGATED_SESSION_ID') ? 'yes' : 'no'}`,
          );
          return ids;
        })
        .finally(() => {
          wlIdsPromise = null;
        });
    }
    return wlIdsPromise;
  };

  const editWatchLater = (videoId, add) =>
    innertube('browse/edit_playlist', {
      playlistId: 'WL',
      actions: [
        add
          ? { action: 'ACTION_ADD_VIDEO', addedVideoId: videoId }
          : { action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: videoId },
      ],
    });

  // ---------- widget ----------

  const makeLink = ({ href, text }) => {
    const a = document.createElement('a');
    a.className = 'wl-toggle-link';
    a.href = href; // real href, so middle-click and ctrl-click open a new tab
    a.textContent = text;
    // Clicking a tile (middle-click especially, which opens a background tab and
    // leaves this page focused) parks focus on the anchor, which would pin the
    // strip open until something else took focus. Drop it so hover alone drives.
    const dropFocus = () => a.blur();
    a.addEventListener('click', dropFocus);
    a.addEventListener('auxclick', dropFocus);
    return a;
  };

  // On a watch page the widget is the toggle button, with both links in an
  // absolutely positioned strip revealed on hover - so the collapsed widget
  // covers no more of the page than the button itself. On the Watch Later
  // playlist and the Subscriptions feed there is no video to toggle, so it is
  // just the one always-visible tile pointing at the other page. Everywhere
  // else both tiles show at once: there is nothing to toggle and no button to
  // hover, so hiding them behind a reveal would leave nothing to aim at.
  const build = (mode) => {
    const wrap = document.createElement('div');
    wrap.id = WRAP_ID;
    wrap.dataset.mode = mode;

    if (mode === WATCH) {
      const btn = document.createElement('button');
      btn.id = BTN_ID;
      btn.type = 'button';
      btn.addEventListener('click', onClick);
      wrap.appendChild(btn);

      const links = document.createElement('div');
      links.id = LINKS_ID;
      links.append(makeLink(LINK_PLAYLIST), makeLink(LINK_SUBS));
      wrap.appendChild(links);
    } else if (mode === SUBS) {
      // 'WL Playlist' here, not just 'Playlist': with no toggle button above it
      // for context, the bare label does not say which playlist it means.
      wrap.appendChild(makeLink({ ...LINK_PLAYLIST, text: 'WL Playlist' }));
    } else if (mode === WL_PAGE) {
      wrap.appendChild(makeLink(LINK_SUBS));
    } else {
      wrap.append(
        makeLink({ ...LINK_PLAYLIST, text: 'WL Playlist' }),
        makeLink(LINK_SUBS),
      );
    }

    document.documentElement.appendChild(wrap);
    return wrap;
  };

  // Rebuilds only when the page kind changes, so SPA navigation between two
  // watch pages leaves the button in place.
  const mount = (mode) => {
    const existing = document.getElementById(WRAP_ID);
    if (existing && existing.dataset.mode === mode) {
      existing.hidden = false;
      return existing;
    }
    if (existing) existing.remove();
    return build(mode);
  };

  // A toggle that resolves after the user has navigated away must not drag the
  // button back onto the new page: mount(WATCH) would rebuild it over a
  // link-only page's tile, or unhide it on a page the widget never belongs on.
  const setState = (state, text) => {
    if (getPage() !== WATCH) return;
    mount(WATCH);
    const btn = document.getElementById(BTN_ID);
    btn.dataset.state = state;
    btn.textContent = text;
  };

  const render = (inWL) =>
    setState(inWL ? 'in' : 'out', inWL ? '✓ In Watch Later' : '+ Watch Later');

  const hide = () => {
    const wrap = document.getElementById(WRAP_ID);
    if (wrap) wrap.hidden = true;
  };

  const flashError = () => {
    // No button once setState has declined to rebuild it off a watch page.
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    const prev = { state: btn.dataset.state, text: btn.textContent };
    setState('error', 'Failed - try again');
    setTimeout(() => {
      const b = document.getElementById(BTN_ID);
      if (b && b.dataset.state === 'error') setState(prev.state, prev.text);
    }, 2000);
  };

  // ---------- actions ----------

  async function onClick() {
    if (inFlight) return;
    const videoId = getVideoId();
    if (!videoId) return;

    const btn = document.getElementById(BTN_ID);
    if (btn.dataset.state === 'retry') return refresh();

    const wasIn = btn.dataset.state === 'in';
    inFlight = true;
    render(!wasIn); // optimistic
    try {
      await editWatchLater(videoId, !wasIn);
      if (wlIds) wasIn ? wlIds.delete(videoId) : wlIds.add(videoId);
    } catch (err) {
      console.warn('[wl-toggle] edit failed:', err);
      // Same guard as refresh(): a failure that lands after the user has moved
      // on must not write video A's state onto video B's button.
      if (getVideoId() === videoId) {
        render(wasIn); // revert
        flashError();
      }
    } finally {
      inFlight = false;
    }
  }

  async function refresh() {
    const page = getPage();
    if (!page) {
      hide();
      return;
    }
    // Nothing to look up on the link-only pages - mount and we are done.
    if (page !== WATCH) {
      mount(page);
      return;
    }

    const videoId = getVideoId();
    if (!videoId || cfg('LOGGED_IN') === false || !getSapisid()) {
      hide();
      return;
    }
    const seq = ++refreshSeq;
    setState('loading', 'Watch Later…');
    try {
      const ids = await watchLaterIds();
      if (seq !== refreshSeq || getVideoId() !== videoId) return; // navigated away mid-check
      render(ids.has(videoId));
    } catch (err) {
      if (seq !== refreshSeq || getVideoId() !== videoId) return;
      console.warn('[wl-toggle] state check failed:', err);
      // Hiding here is what made this look like the button "flashing and
      // vanishing" - leave it visible and clickable so a failure can be retried.
      setState('retry', '⟳ Watch Later');
    }
  }

  // ---------- card overlay ----------

  // One button that follows the pointer from card to card, rather than one
  // injected into every card. It is appended to documentElement alongside the
  // main widget, which keeps three things true that per-card injection would
  // cost: nothing is injected inside ytd-app, so YouTube reshuffling its
  // renderers cannot break us; nothing has to be re-decorated when YouTube
  // recycles a card element with a different video on scroll; and being fixed
  // and outside ytd-app it paints over the inline preview player by z-index
  // alone, instead of fighting for stacking order as a sibling of it.
  // The price is repositioning on scroll, which is what queuePlace() is for.

  // Keyed off the href, not a renderer tag name: YouTube is midway through
  // replacing ytd-*-renderer with yt-lockup-view-model, and both generations
  // put the video id on the thumbnail's own anchor. The image test is what
  // separates that anchor from the title anchor beside it, which points at the
  // same video but is too small and too text-shaped to hang a button off.
  //
  // The size floor is not belt-and-braces. A watch page carries a dozen anchors
  // that pass the image test while being invisible: description links
  // (ytAttributedStringLink) wrap an img, and collapsed sidebar thumbnails keep
  // theirs in the DOM at zero size. Measuring is the only thing that separates a
  // thumbnail you can point at from markup that merely looks like one.
  const thumbAnchor = (target) => {
    if (!(target instanceof Element)) return null;
    const a = target.closest('a[href*="/watch?v="]');
    if (!a) return null;
    if (a.id !== 'thumbnail' && !a.querySelector('img, yt-image, ytd-thumbnail')) return null;
    const rect = a.getBoundingClientRect();
    if (rect.width < CARD_MIN_W || rect.height < CARD_MIN_H) return null;
    return a;
  };

  const idFromHref = (href) => {
    try {
      return new URL(href, ORIGIN).searchParams.get('v');
    } catch {
      return null;
    }
  };

  const cardButton = () => {
    let btn = document.getElementById(CARD_BTN_ID);
    if (btn) return btn;
    btn = document.createElement('button');
    btn.id = CARD_BTN_ID;
    btn.type = 'button';
    btn.hidden = true;
    // The button is outside ytd-app, so a click on it never reaches the card
    // anchor underneath and there is no navigation to suppress.
    btn.addEventListener('click', onCardClick);
    document.documentElement.appendChild(btn);
    return btn;
  };

  const placeCard = () => {
    const btn = document.getElementById(CARD_BTN_ID);
    if (!btn || !cardAnchor) return;
    const rect = cardAnchor.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      hideCard();
      return;
    }
    btn.style.top = `${rect.top + CARD_INSET}px`;
    btn.style.left = `${rect.left + CARD_INSET}px`;
  };

  const queuePlace = () => {
    if (cardFrame) return;
    cardFrame = requestAnimationFrame(() => {
      cardFrame = 0;
      placeCard();
    });
  };

  // Bumping the sequence is what makes hiding safe: an edit or a state check
  // that resolves after the pointer has moved on finds a stale seq and writes
  // nothing, so card A's result can never land on card B's button.
  const hideCard = () => {
    const btn = document.getElementById(CARD_BTN_ID);
    if (btn) btn.hidden = true;
    cardAnchor = null;
    cardVideoId = null;
    cardSeq++;
  };

  const setCardState = (state, label, title) => {
    const btn = document.getElementById(CARD_BTN_ID);
    if (!btn) return;
    btn.dataset.state = state;
    btn.textContent = label;
    btn.title = title;
  };

  const renderCard = (inWL) =>
    inWL
      ? setCardState('in', '\u2713', 'In Watch Later - click to remove')
      : setCardState('out', '+', 'Add to Watch Later');

  const flashCardError = (revertTo) => {
    setCardState('error', '!', 'Failed - try again');
    setTimeout(() => {
      const btn = document.getElementById(CARD_BTN_ID);
      if (btn && btn.dataset.state === 'error') renderCard(revertTo);
    }, 2000);
  };

  async function onCardEnter(anchor) {
    const videoId = idFromHref(anchor.href);
    // Same three preconditions as the watch button: a video, a session, and a
    // page the widget belongs on (getPage() is null only inside an embed).
    if (!videoId || !getPage() || cfg('LOGGED_IN') === false || !getSapisid()) {
      hideCard();
      return;
    }

    cardAnchor = anchor;
    cardVideoId = videoId;
    const seq = ++cardSeq;
    cardButton().hidden = false;
    placeCard();

    // A warm cache is the normal case, and answering synchronously avoids a
    // loading state that would flicker on every card the pointer crosses.
    if (wlIds && Date.now() - wlIdsAt < WL_CACHE_TTL) {
      renderCard(wlIds.has(videoId));
      return;
    }
    setCardState('loading', '\u2026', 'Checking Watch Later\u2026');
    try {
      const ids = await watchLaterIds();
      if (seq !== cardSeq) return;
      renderCard(ids.has(videoId));
    } catch (err) {
      if (seq !== cardSeq) return;
      console.warn('[wl-toggle] card state check failed:', err);
      setCardState('retry', '\u27f3', 'State check failed - click to retry');
    }
  }

  async function onCardClick() {
    const btn = document.getElementById(CARD_BTN_ID);
    const videoId = cardVideoId;
    const anchor = cardAnchor;
    if (!btn || !videoId || !anchor) return;
    if (btn.dataset.state === 'loading') return;
    if (btn.dataset.state === 'retry') return onCardEnter(anchor);

    const wasIn = btn.dataset.state === 'in';
    const seq = cardSeq;
    renderCard(!wasIn); // optimistic
    try {
      await editWatchLater(videoId, !wasIn);
      // Patch the cache whatever the pointer has done since - the edit landed,
      // and the next card to ask about this video should hear about it.
      if (wlIds) wasIn ? wlIds.delete(videoId) : wlIds.add(videoId);
      // Keep the two buttons agreeing when they are showing the same video.
      if (getVideoId() === videoId) render(!wasIn);
    } catch (err) {
      console.warn('[wl-toggle] card edit failed:', err);
      if (seq !== cardSeq) return; // pointer moved on, nothing left to revert
      renderCard(wasIn);
      flashCardError(wasIn);
    }
  }

  // Capture phase, because YouTube stops propagation on some of its own cards.
  document.addEventListener('pointerover', (e) => {
    const anchor = thumbAnchor(e.target);
    if (anchor) {
      if (anchor !== cardAnchor) onCardEnter(anchor);
      return;
    }
    // Moving onto the button itself is not leaving the card - it sits over the
    // thumbnail, so hiding here would make it unclickable.
    const btn = document.getElementById(CARD_BTN_ID);
    if (btn && !btn.hidden && (e.target === btn || btn.contains(e.target))) return;
    hideCard();
  }, true);

  // Capture again: the feed scrolls in a container, not on window.
  window.addEventListener('scroll', queuePlace, true);
  window.addEventListener('resize', queuePlace);

  // YouTube is a SPA - full page loads are rare, this event fires on every navigation.
  window.addEventListener('yt-navigate-finish', () => {
    hideCard();
    refresh();
  });
  refresh();
})();
