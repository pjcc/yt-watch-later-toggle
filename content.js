// Watch Later Toggle - runs in the page's MAIN world so it can read
// window.ytcfg and call YouTube's InnerTube API with the page's own session.
(() => {
  'use strict';

  const ORIGIN = 'https://www.youtube.com';
  const WRAP_ID = 'wl-toggle-wrap';
  const BTN_ID = 'wl-toggle-btn';
  const LINKS_ID = 'wl-toggle-links';
  const CARD_BTN_ID = 'wl-card-btn';

  // On small thumbnails the button covers the left half, full height. A small
  // corner target was too easy to lose against a playing preview; this stays
  // findable without hunting, and keeps clear of the mute and captions controls
  // the preview player puts top-right.
  const CARD_COVER = 0.5;
  // Large thumbnails (feed and search grids, 426x251 on the subscriptions feed
  // at desktop width) get only the top-left quarter instead: their preview
  // player has a scrub bar along the bottom edge, and a full-height button
  // covered the left half of it. The cut-off sits well above the watch-page
  // sidebar and playlist panel (100x56 measured in the panel), where a quarter
  // would be too small to hit, and below the grid cards.
  const CARD_LARGE_H = 120;
  // Floor for what counts as a thumbnail. YouTube's smallest real one is about
  // 100x56 in the compact sidebar, and nothing legitimate is under this.
  const CARD_MIN_W = 80;
  const CARD_MIN_H = 45;

  const LINK_PLAYLIST = { href: `${ORIGIN}/playlist?list=WL`, text: 'Playlist' };
  const LINK_SUBS = { href: `${ORIGIN}/feed/subscriptions`, text: 'Subscriptions' };
  const LINK_HISTORY = { href: `${ORIGIN}/feed/history`, text: 'History' };

  // The three pages with a bespoke widget, plus the catch-all everywhere else.
  const WATCH = 'watch';
  const SUBS = 'subs';
  const WL_PAGE = 'wl';
  const OTHER = 'other';

  // The tiles each mode shows, top to bottom. A page never links to itself.
  // The catch-all keeps to Playlist and Subscriptions, which also covers the
  // History page without it offering a link back to itself.
  const MODE_LINKS = {
    [WATCH]: [LINK_PLAYLIST, LINK_SUBS, LINK_HISTORY],
    [SUBS]: [LINK_PLAYLIST, LINK_HISTORY],
    [WL_PAGE]: [LINK_SUBS, LINK_HISTORY],
    [OTHER]: [LINK_PLAYLIST, LINK_SUBS],
  };

  // Watch Later can be long, so the id set is cached rather than re-listed on
  // every SPA navigation; toggles patch the cache so it stays correct in between.
  const WL_CACHE_TTL = 5 * 60 * 1000;
  // Raised from 20 when the card buttons landed. One wrong 'not saved' on a
  // watch page is a single button; across a grid of forty cards it is obvious.
  const WL_MAX_PAGES = 50; // ~5000 videos, then we stop paging

  // Video ids with an edit in flight, shared by both buttons. Without it a
  // double-click fired an add and a remove together, which can land in either
  // order and leave the button saying the opposite of the playlist.
  const pending = new Set();
  let refreshSeq = 0;
  let wlIds = null;
  let wlIdsAt = 0;
  let wlIdsPromise = null;

  // The card button that follows the pointer, and what it is currently showing.
  let cardAnchor = null;
  let cardVideoId = null;
  let cardRect = null;
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

  const hasSession = () => cfg('LOGGED_IN') !== false && !!getSapisid();

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

  // The cached set if it is still inside its TTL, else null. Callers with a
  // synchronous fast path use this to skip a loading state that would flicker.
  const freshIds = () => (wlIds && Date.now() - wlIdsAt < WL_CACHE_TTL ? wlIds : null);

  const watchLaterIds = () => {
    const cached = freshIds();
    if (cached) return Promise.resolve(cached);
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

  // Both buttons edit through here, so the in-flight guard and the cache patch
  // cannot drift apart between them. The patch keeps the cache correct without
  // a re-list, and runs whatever the UI has done since - the edit landed, so
  // the next button to ask about this video should hear about it.
  const editWatchLater = async (videoId, add) => {
    pending.add(videoId);
    try {
      await innertube('browse/edit_playlist', {
        playlistId: 'WL',
        actions: [
          add
            ? { action: 'ACTION_ADD_VIDEO', addedVideoId: videoId }
            : { action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: videoId },
        ],
      });
      if (wlIds) add ? wlIds.add(videoId) : wlIds.delete(videoId);
    } finally {
      pending.delete(videoId);
    }
  };

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

  // On a watch page the widget is the toggle button, with its links in an
  // absolutely positioned strip revealed on hover - so the collapsed widget
  // covers no more of the page than the button itself. Everywhere else there
  // is nothing to toggle and no button to hover, so the tiles are always
  // visible: hiding them behind a reveal would leave nothing to aim at.
  // MODE_LINKS decides which tiles each mode gets.
  const build = (mode) => {
    const wrap = document.createElement('div');
    wrap.id = WRAP_ID;
    wrap.dataset.mode = mode;
    const tiles = MODE_LINKS[mode].map(makeLink);

    if (mode === WATCH) {
      const btn = document.createElement('button');
      btn.id = BTN_ID;
      btn.type = 'button';
      btn.addEventListener('click', onClick);

      const links = document.createElement('div');
      links.id = LINKS_ID;
      links.append(...tiles);
      wrap.append(btn, links);
    } else {
      wrap.append(...tiles);
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
  //
  // `saved` is the settled membership a click toggles away from, kept in
  // data-saved rather than read off data-state. Reading the state made a click
  // during 'loading' always add, and a click on 'Failed - try again' after a
  // failed remove add as well; the error flash now carries the membership it
  // reverted to, so retrying repeats the edit that failed. States with no
  // settled membership ('loading', 'retry') leave it unset and clicks ignore them.
  const setState = (state, text, saved) => {
    if (getPage() !== WATCH) return;
    mount(WATCH);
    const btn = document.getElementById(BTN_ID);
    btn.dataset.state = state;
    btn.textContent = text;
    if (saved === undefined) delete btn.dataset.saved;
    else btn.dataset.saved = String(saved);
  };

  const render = (inWL) =>
    setState(inWL ? 'in' : 'out', inWL ? '✓ In Watch Later' : '+ Watch Later', inWL);

  const hide = () => {
    const wrap = document.getElementById(WRAP_ID);
    if (wrap) wrap.hidden = true;
  };

  const flashError = (revertTo) => {
    // No button once setState has declined to rebuild it off a watch page.
    if (!document.getElementById(BTN_ID)) return;
    setState('error', 'Failed - try again', revertTo);
    setTimeout(() => {
      const b = document.getElementById(BTN_ID);
      if (b && b.dataset.state === 'error') render(revertTo);
    }, 2000);
  };

  // ---------- actions ----------

  async function onClick() {
    const videoId = getVideoId();
    const btn = document.getElementById(BTN_ID);
    if (!videoId || !btn) return;
    if (btn.dataset.state === 'retry') return refresh();
    if (btn.dataset.saved === undefined || pending.has(videoId)) return;

    const wasIn = btn.dataset.saved === 'true';
    render(!wasIn); // optimistic
    try {
      await editWatchLater(videoId, !wasIn);
      syncButtons(videoId, !wasIn);
    } catch (err) {
      console.warn('[wl-toggle] edit failed:', err);
      // Same guard as refresh(): a failure that lands after the user has moved
      // on must not write video A's state onto video B's button.
      if (getVideoId() === videoId) flashError(wasIn);
    }
  }

  // Keep the two buttons agreeing when they are showing the same video.
  const syncButtons = (videoId, inWL) => {
    if (getVideoId() === videoId) render(inWL);
    if (cardVideoId === videoId) renderCard(inWL);
  };

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
    if (!videoId || !hasSession()) {
      hide();
      return;
    }
    const seq = ++refreshSeq;
    // Same fast path as the card button: with a warm cache, skip the loading
    // state that otherwise flickered on every SPA navigation between videos.
    const cached = freshIds();
    if (cached) {
      render(cached.has(videoId));
      return;
    }
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
  //
  // An anchor that wraps another watch anchor is a whole row, not a thumbnail.
  // The playlist panel beside a watch page does this: a#wc-endpoint (492x56)
  // wraps the row, a#thumbnail (100x56) inside it. Hovering the thumbnail
  // matched the inner one and hovering the title matched the row - which
  // passes the image test via the thumbnail inside it - so the cover flipped
  // between thumbnail-sized and half the row. Hovering a title elsewhere shows
  // no button, so the row anchor is rejected rather than resolved downwards.
  const thumbAnchor = (target) => {
    if (!(target instanceof Element)) return null;
    const a = target.closest('a[href*="/watch?v="]');
    if (!a) return null;
    if (a.querySelector('a[href*="/watch?v="]')) return null;
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
    if (!btn || !cardRect) return;
    if (cardAnchor && cardAnchor.isConnected) {
      const live = cardAnchor.getBoundingClientRect();
      // While the inline preview mounts, the anchor can briefly measure zero.
      // Keep the last good rect rather than throwing the button away over it.
      if (live.width && live.height) cardRect = live;
    }
    const large = cardRect.height >= CARD_LARGE_H;
    const height = cardRect.height * (large ? CARD_COVER : 1);
    btn.dataset.size = large ? 'large' : 'small';
    btn.style.top = `${cardRect.top}px`;
    btn.style.left = `${cardRect.left}px`;
    btn.style.width = `${Math.round(cardRect.width * CARD_COVER)}px`;
    btn.style.height = `${Math.round(height)}px`;
    btn.style.fontSize = `${Math.max(18, Math.round(height * 0.3))}px`;
  };

  const withinCard = (x, y) =>
    !!cardRect &&
    x >= cardRect.left && x <= cardRect.right &&
    y >= cardRect.top && y <= cardRect.bottom;

  // Scroll fires constantly; with no card showing there is nothing to place.
  const queuePlace = () => {
    if (cardFrame || !cardRect) return;
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
    cardRect = null;
    cardSeq++;
  };

  // `saved` works exactly as it does for the watch-page button's setState.
  const setCardState = (state, label, title, saved) => {
    const btn = document.getElementById(CARD_BTN_ID);
    if (!btn) return;
    btn.dataset.state = state;
    btn.textContent = label;
    btn.title = title;
    if (saved === undefined) delete btn.dataset.saved;
    else btn.dataset.saved = String(saved);
  };

  const renderCard = (inWL) =>
    inWL
      ? setCardState('in', '\u2713', 'In Watch Later - click to remove', true)
      : setCardState('out', '+', 'Add to Watch Later', false);

  const flashCardError = (revertTo) => {
    setCardState('error', '!', 'Failed - try again', revertTo);
    setTimeout(() => {
      const btn = document.getElementById(CARD_BTN_ID);
      if (btn && btn.dataset.state === 'error') renderCard(revertTo);
    }, 2000);
  };

  async function onCardEnter(anchor) {
    const videoId = idFromHref(anchor.href);
    // Same three preconditions as the watch button: a video, a session, and a
    // page the widget belongs on (getPage() is null only inside an embed).
    if (!videoId || !getPage() || !hasSession()) {
      hideCard();
      return;
    }

    cardAnchor = anchor;
    cardVideoId = videoId;
    cardRect = anchor.getBoundingClientRect();
    const seq = ++cardSeq;
    cardButton().hidden = false;
    placeCard();

    // A warm cache is the normal case, and answering synchronously avoids a
    // loading state that would flicker on every card the pointer crosses.
    const cached = freshIds();
    if (cached) {
      renderCard(cached.has(videoId));
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
    if (btn.dataset.state === 'retry') return onCardEnter(anchor);
    if (btn.dataset.saved === undefined || pending.has(videoId)) return;

    const wasIn = btn.dataset.saved === 'true';
    const seq = cardSeq;
    renderCard(!wasIn); // optimistic
    try {
      await editWatchLater(videoId, !wasIn);
      syncButtons(videoId, !wasIn);
    } catch (err) {
      console.warn('[wl-toggle] card edit failed:', err);
      if (seq !== cardSeq) return; // pointer moved on, nothing left to revert
      flashCardError(wasIn);
    }
  }

  // Capture phase, because YouTube stops propagation on some of its own cards.
  document.addEventListener('pointerover', (e) => {
    const anchor = thumbAnchor(e.target);
    if (anchor) {
      if (anchor === cardAnchor) return;
      // Starting the preview re-renders the card, so the anchor element changes
      // identity while still pointing at the same video. Re-entering would
      // restart the state check and flash the button; adopt the new element and
      // keep what is already on screen.
      if (cardVideoId && idFromHref(anchor.href) === cardVideoId) {
        cardAnchor = anchor;
        placeCard();
        return;
      }
      onCardEnter(anchor);
      return;
    }
    if (!cardAnchor) return;
    // Moving onto the button itself is not leaving the card - it sits over the
    // thumbnail, so hiding here would make it unclickable.
    const btn = document.getElementById(CARD_BTN_ID);
    if (btn && !btn.hidden && (e.target === btn || btn.contains(e.target))) return;
    // Leaving is decided by where the pointer is, not by what it is over.
    // Hovering a card starts YouTube's inline preview player, which replaces
    // the thumbnail's contents - and those nodes do not resolve back to the
    // anchor, so an ancestry test hid the button the instant the preview began.
    // That was the flash: shown on hover, hidden a moment later by the preview.
    if (withinCard(e.clientX, e.clientY)) return;
    hideCard();
  }, true);

  // The pointer can leave the card without entering anything else - out of the
  // window, or into a native control - and no pointerover would follow.
  document.addEventListener('pointerleave', () => hideCard());

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
