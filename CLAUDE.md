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

**Membership detection is a full playlist listing, not a lookup.** `listWatchLaterIds()` pages `POST /youtubei/v1/browse` with `browseId: 'VLWL'`, walking the response tree for `playlistVideoRenderer.videoId` and continuation tokens, capped at `WL_MAX_PAGES` (50, roughly 5000 videos; it logs a warning when the cap cuts the listing short). Do not "simplify" this back to `playlist/get_add_to_playlist`: that endpoint reports Watch Later under a per-account playlist id rather than the `WL` alias, and its `containsSelectedVideos` is always `NONE` for WL even for videos that are in it. The comment above `listWatchLaterIds` records this; it is a dead end that was already tried.

**Caching offsets the listing cost.** The id set is cached for `WL_CACHE_TTL` (5 minutes), concurrent callers share `wlIdsPromise`, and `editWatchLater` patches `wlIds` directly after a successful edit so the cache stays correct without a re-list. `freshIds()` is the synchronous fast path: `refresh()` and `onCardEnter()` both render straight from a warm cache instead of flashing a loading state.

**Toggling** uses `POST /youtubei/v1/browse/edit_playlist` against `playlistId: 'WL'` with `ACTION_ADD_VIDEO` / `ACTION_REMOVE_VIDEO_BY_VIDEO_ID`. The UI updates optimistically and reverts on failure. Both buttons go through `editWatchLater`, which owns the `pending` set of video ids with an edit in flight; a click on a pending video is ignored, so a double-click cannot race an add against a remove.

**SPA handling.** `refresh()` runs once at injection and on every `yt-navigate-finish`. `refreshSeq` guards against a stale in-flight check rendering after the user has navigated on, and the click path has the matching guard: `onClick` only reverts on failure while `getVideoId()` still matches, and `setState` refuses to run off a watch page. Without those, a toggle that failed after navigation called `mount(WATCH)` and rebuilt the button over a link-only page's tile, or unhid it on a page the widget never belongs on.

**Button states** live entirely in `data-state` on `#wl-toggle-btn`, with each state's appearance in `styles.css`: `out`, `in`, `loading`, `error` (transient, 2s), `retry`. The `retry` state exists because hiding the button on a failed state check read as the button flashing and vanishing; keep failures visible and clickable rather than reverting to `hide()`. What a click toggles *from* is `data-saved`, not `data-state`: deriving it from the state made a click during `loading` always add, and a click on the `error` flash after a failed remove add too. `loading` and `retry` leave `data-saved` unset and clicks ignore them; `error` carries the membership it reverted to, so clicking it retries the failed edit. The card button follows the same contract.

**The widget is page-aware and rebuilt by mode.** `getPage()` returns `watch`, `subs` (`/feed/subscriptions`), `wl` (`/playlist?list=WL`), `other` for anything else, or null for `/embed/*` only. `MODE_LINKS` lists each mode's tiles: Playlist, Subscriptions and History on `watch` (in the hover strip); the other two of the three on `subs` and `wl`; Playlist and Subscriptions on `other`, which also covers `/feed/history` without it linking to itself. `build(mode)` produces the toggle button plus hover strip on `watch` and always-visible stacked tiles everywhere else. The wrap is `display: flex` in its base rule so `#wl-toggle-wrap[hidden]` out-ranks it - when the flex rule was a `[data-mode]` selector declared later, a hidden widget stayed visible. `mount()` rebuilds only when the mode changes, so navigating between watch pages leaves the button alone. Every mode but `watch` returns from `refresh()` before any InnerTube call, so the catch-all costs nothing. `hide()` is still reachable - `/embed/*`, and the watch page when logged out or without a video id.

**Card buttons are one moving overlay, not per-card injection.** `thumbAnchor()` resolves the thumbnail under the pointer and a single `#wl-card-btn`, appended to `documentElement`, is positioned over it. Per-card injection was rejected for three reasons: it would put extension nodes inside `ytd-app` and couple us to YouTube's renderer markup; YouTube recycles card elements with different videos on scroll, so injected nodes need re-checking against the current id anyway; and an injected sibling has to win a stacking contest against the inline preview player, which a fixed element outside `ytd-app` wins on z-index alone. The cost is `queuePlace()`, an rAF-throttled reposition on scroll and resize.

`thumbAnchor()` keys off `a[href*="/watch?v="]` rather than a renderer tag name because YouTube is midway through replacing `ytd-*-renderer` with `yt-lockup-view-model` and both generations put the id on the thumbnail anchor. The image test rejects the title anchor beside it. An anchor that contains another watch anchor is rejected too: the watch page's playlist panel wraps each whole row, drag handle included, in `a#wc-endpoint` around the thumbnail's own `a#thumbnail`. Matching the row made the cover flip between thumbnail-sized and half the row depending on whether the pointer was on the thumbnail or the title, and the row version sat over the reorder handle. **The size floor is load-bearing, not defensive**: a watch page carries a dozen anchors that pass the image test while being invisible - description links (`ytAttributedStringLink`) wrap an `img`, and collapsed sidebar thumbnails keep theirs at zero size. Measured on a live watch page, dropping the floor turns 4 real thumbnails into 16 matches, 12 of them unpointable.

**Cover size depends on the thumbnail.** Below `CARD_LARGE_H` (120px) the card button covers the left half at full height; at or above it (feed and search grids) only the top-left quarter, so the preview player's bottom scrub bar stays reachable across its whole width. `placeCard()` sets `data-size`, and the CSS swaps the corner radius and the `--wl-fade` gradient direction from it.

**Hovering a card starts YouTube's inline preview player, and that breaks two naive assumptions.** The preview replaces the thumbnail's contents, so its nodes do not resolve back through `closest()` to the thumbnail anchor - an ancestry test for "has the pointer left the card" hid the button the instant the preview began, which read as the button flashing on and vanishing. Leaving is therefore decided by geometry, `withinCard(x, y)` against the last known rect. The same re-render also changes the anchor's *element identity* while the video stays the same, so the `pointerover` handler compares video ids before treating a new anchor as a new card, and `placeCard()` keeps the last good rect when the detached anchor measures zero. All three exist for the same underlying reason; do not unpick one without the others.

`cardSeq` is the card equivalent of `refreshSeq`, and `hideCard()` bumps it deliberately: an edit or state check that resolves after the pointer has moved finds a stale seq and writes nothing, so card A's result can never land on card B's button. The cache patch on a successful edit deliberately sits *outside* that guard - the edit landed, so the next card asking about that video should hear about it.

**Two non-obvious layout choices in the hover strip:**

- `#wl-toggle-links` is absolutely positioned and `pointer-events: none` while collapsed, so the widget's hit area stays exactly button-sized and never blocks the page. The gap to the first tile is `padding-top` *inside* the strip, so it stays hoverable once expanded - do not turn it into a margin
- Reveal keys off `#wl-toggle-wrap:has(:focus-visible)`, not `:focus-within`. The latter stays true after a mouse click and pinned the strip open; the anchors also blur themselves on `click` and `auxclick`. Needs Chrome 105+ for `:has()`

Tiles are real `<a href>` elements with no click handler, so middle-click and ctrl-click open a new tab natively. The widget is appended to `documentElement`, outside `ytd-app`, so YouTube's SPA router does not intercept those navigations - keep it there.

## Conventions

- Vanilla ES2020+ in a single IIFE, no frameworks, no bundler. Keep it that way unless asked
- All logging is prefixed `[wl-toggle]`; `console.debug` for state, `console.warn` for failures
- Comments in `content.js` explain *why* (dead-end APIs, brand-account headers, past UX bugs). Preserve them when refactoring - they are the record of what has already been ruled out
- Bump `version` in `manifest.json` for user-visible changes, and keep `README.md`'s "How it works", "States" and "Caveats" sections in sync with behaviour changes
