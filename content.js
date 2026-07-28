// Watch Later Toggle - runs in the page's MAIN world so it can read
// window.ytcfg and call YouTube's InnerTube API with the page's own session.
(() => {
  'use strict';

  const ORIGIN = 'https://www.youtube.com';
  const BTN_ID = 'wl-toggle-btn';

  let inFlight = false;
  let refreshSeq = 0;

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

  // Same call the native Save dialog makes; the WL entry carries membership state.
  const isInWatchLater = async (videoId) => {
    const data = await innertube('playlist/get_add_to_playlist', { videoIds: [videoId] });
    const playlists = data?.contents?.[0]?.addToPlaylistRenderer?.playlists ?? [];
    const wl = playlists
      .map((p) => p.playlistAddToOptionRenderer)
      .find((p) => p && p.playlistId === 'WL');
    console.debug(
      `[wl-toggle] ${videoId}: WL=${wl ? wl.containsSelectedVideos : 'MISSING'}`,
      `authuser=${cfg('SESSION_INDEX') || '0'}`,
      `pageId=${cfg('DELEGATED_SESSION_ID') || 'none'}`,
      `playlists=${playlists.length}`,
    );
    if (!wl) throw new Error('WL playlist missing from get_add_to_playlist response');
    return wl.containsSelectedVideos !== 'NONE';
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

    const wasIn = getButton().dataset.state === 'in';
    inFlight = true;
    render(!wasIn); // optimistic
    try {
      await editWatchLater(videoId, !wasIn);
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
      const inWL = await isInWatchLater(videoId);
      if (seq !== refreshSeq || getVideoId() !== videoId) return; // navigated away mid-check
      render(inWL);
    } catch (err) {
      if (seq !== refreshSeq) return;
      console.warn('[wl-toggle] state check failed:', err);
      hide();
    }
  }

  // YouTube is a SPA - full page loads are rare, this event fires on every navigation.
  window.addEventListener('yt-navigate-finish', refresh);
  refresh();
})();
