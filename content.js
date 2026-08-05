// Watch Later Toggle - runs in the page's MAIN world so it can read
// window.ytcfg and call YouTube's InnerTube API with the page's own session.
(() => {
  'use strict';

  const ORIGIN = 'https://www.youtube.com';
  const BTN_ID = 'wl-toggle-btn';

  // Watch Later can be long, so the id set is cached rather than re-listed on
  // every SPA navigation; toggles patch the cache so it stays correct in between.
  const WL_CACHE_TTL = 5 * 60 * 1000;
  const WL_MAX_PAGES = 20; // ~2000 videos, then we stop paging

  let inFlight = false;
  let refreshSeq = 0;
  let wlIds = null;
  let wlIdsAt = 0;
  let wlIdsPromise = null;

  // ---------- helpers ----------

  const getVideoId = () =>
    location.pathname === '/watch'
      ? new URLSearchParams(location.search).get('v')
      : null;

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
    return ids;
  };

  const watchLaterIds = () => {
    if (wlIds && Date.now() - wlIdsAt < WL_CACHE_TTL) return Promise.resolve(wlIds);
    if (!wlIdsPromise) {
      wlIdsPromise = listWatchLaterIds()
        .then((ids) => {
          wlIds = ids;
          wlIdsAt = Date.now();
          console.debug(
            `[wl-toggle] listed ${ids.size} Watch Later videos`,
            `authuser=${cfg('SESSION_INDEX') || '0'}`,
            `pageId=${cfg('DELEGATED_SESSION_ID') || 'none'}`,
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

  // ---------- button ----------

  const getButton = () => {
    let btn = document.getElementById(BTN_ID);
    if (!btn) {
      btn = document.createElement('button');
      btn.id = BTN_ID;
      btn.type = 'button';
      btn.addEventListener('click', onClick);
      document.documentElement.appendChild(btn);
    }
    return btn;
  };

  const setState = (state, text) => {
    const btn = getButton();
    btn.dataset.state = state;
    btn.textContent = text;
    btn.hidden = false;
  };

  const render = (inWL) =>
    setState(inWL ? 'in' : 'out', inWL ? '✓ In Watch Later' : '+ Watch Later');

  const hide = () => {
    const btn = document.getElementById(BTN_ID);
    if (btn) btn.hidden = true;
  };

  const flashError = () => {
    const btn = getButton();
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

    const btn = getButton();
    if (btn.dataset.state === 'retry') return refresh();

    const wasIn = btn.dataset.state === 'in';
    inFlight = true;
    render(!wasIn); // optimistic
    try {
      await editWatchLater(videoId, !wasIn);
      if (wlIds) wasIn ? wlIds.delete(videoId) : wlIds.add(videoId);
    } catch (err) {
      console.warn('[wl-toggle] edit failed:', err);
      render(wasIn); // revert
      flashError();
    } finally {
      inFlight = false;
    }
  }

  async function refresh() {
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
      if (seq !== refreshSeq) return;
      console.warn('[wl-toggle] state check failed:', err);
      // Hiding here is what made this look like the button "flashing and
      // vanishing" - leave it visible and clickable so a failure can be retried.
      setState('retry', '⟳ Watch Later');
    }
  }

  // YouTube is a SPA - full page loads are rare, this event fires on every navigation.
  window.addEventListener('yt-navigate-finish', refresh);
  refresh();
})();
