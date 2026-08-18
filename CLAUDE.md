# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Chrome Manifest V3 extension that adds a single fixed-position button to YouTube watch pages for toggling the current video in/out of the Watch Later playlist. Four files, no build step, no dependencies, no test suite: `manifest.json`, `content.js`, `styles.css`, `README.md`.

## Development workflow

There is nothing to build, install, or transpile. Edits to `content.js` / `styles.css` are the deliverable as-is.

- Load: `chrome://extensions` -> Developer mode -> Load unpacked -> this folder
- After editing: hit Reload on the extension card at `chrome://extensions`, then hard-reload the YouTube tab (the content script only re-injects on page load, not on SPA navigation)
- Debug: DevTools console on the YouTube tab, filter on `[wl-toggle]`. Because the script runs in the MAIN world, its logs appear in the normal page console, not an isolated extension context
- Verify behaviour manually on a watch page: state on load, toggle both directions, SPA navigation to another video, and a logged-out or non-watch page (button hidden)

## Architecture

**MAIN world content script.** `manifest.json` sets `"world": "MAIN"` deliberately - the script needs `window.ytcfg` to read `INNERTUBE_API_KEY`, `INNERTUBE_CONTEXT`, `SESSION_INDEX`, `DELEGATED_SESSION_ID` and `LOGGED_IN`. An isolated-world script cannot see these, so moving off MAIN would break authentication entirely.

**Auth.** No OAuth and no extension permissions beyond the content script match. Requests reuse the page's cookies plus a `SAPISIDHASH` header computed as `SHA1("<unix-secs> <SAPISID> https://www.youtube.com")`. `X-Goog-PageId` from `DELEGATED_SESSION_ID` is required for brand/channel accounts, otherwise InnerTube answers for the primary Google account whose Watch Later is a different playlist.

**Membership detection is a full playlist listing, not a lookup.** `listWatchLaterIds()` pages `POST /youtubei/v1/browse` with `browseId: 'VLWL'`, walking the response tree for `playlistVideoRenderer.videoId` and continuation tokens, capped at `WL_MAX_PAGES` (20, roughly 2000 videos). Do not "simplify" this back to `playlist/get_add_to_playlist`: that endpoint reports Watch Later under a per-account playlist id rather than the `WL` alias, and its `containsSelectedVideos` is always `NONE` for WL even for videos that are in it. The comment above `listWatchLaterIds` records this; it is a dead end that was already tried.

**Caching offsets the listing cost.** The id set is cached for `WL_CACHE_TTL` (5 minutes), concurrent callers share `wlIdsPromise`, and `onClick` patches `wlIds` directly after a successful edit so the cache stays correct without a re-list.

**Toggling** uses `POST /youtubei/v1/browse/edit_playlist` against `playlistId: 'WL'` with `ACTION_ADD_VIDEO` / `ACTION_REMOVE_VIDEO_BY_VIDEO_ID`. The UI updates optimistically and reverts on failure.

**SPA handling.** `refresh()` runs once at injection and on every `yt-navigate-finish`. `refreshSeq` guards against a stale in-flight check rendering after the user has navigated on.

**Button states** live entirely in `data-state` on `#wl-toggle-btn`, with each state's appearance in `styles.css`: `out`, `in`, `loading`, `error` (transient, 2s), `retry`. The `retry` state exists because hiding the button on a failed state check read as the button flashing and vanishing; keep failures visible and clickable rather than reverting to `hide()`.

**The widget is page-aware and rebuilt by mode.** `getPage()` returns `watch`, `subs` (`/feed/subscriptions`), `wl` (`/playlist?list=WL`) or null, and `build(mode)` produces either the toggle button with a hover-revealed link strip or, on the two link-only pages, a single always-visible tile pointing at the other page. `mount()` rebuilds only when the mode changes, so navigating between watch pages leaves the button alone. The link-only pages return from `refresh()` before any InnerTube call.

**Two non-obvious layout choices in the hover strip:**

- `#wl-toggle-links` is absolutely positioned and `pointer-events: none` while collapsed, so the widget's hit area stays exactly button-sized and never blocks the page. The gap to the first tile is `padding-top` *inside* the strip, so it stays hoverable once expanded - do not turn it into a margin
- Reveal keys off `#wl-toggle-wrap:has(:focus-visible)`, not `:focus-within`. The latter stays true after a mouse click and pinned the strip open; the anchors also blur themselves on `click` and `auxclick`. Needs Chrome 105+ for `:has()`

Tiles are real `<a href>` elements with no click handler, so middle-click and ctrl-click open a new tab natively. The widget is appended to `documentElement`, outside `ytd-app`, so YouTube's SPA router does not intercept those navigations - keep it there.

## Conventions

- Vanilla ES2020+ in a single IIFE, no frameworks, no bundler. Keep it that way unless asked
- All logging is prefixed `[wl-toggle]`; `console.debug` for state, `console.warn` for failures
- Comments in `content.js` explain *why* (dead-end APIs, brand-account headers, past UX bugs). Preserve them when refactoring - they are the record of what has already been ruled out
- Bump `version` in `manifest.json` for user-visible changes, and keep `README.md`'s "How it works", "States" and "Caveats" sections in sync with behaviour changes
