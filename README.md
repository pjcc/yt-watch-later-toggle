# Watch Later Toggle

Chrome extension for Watch Later. A button top-right of every YouTube watch page adds or removes the current video, and hovering any video thumbnail anywhere on YouTube gives you the same toggle for that video. Both detect membership first, so they show whether the video is already saved before you click. Hovering the watch-page button reveals quick links to the Watch Later playlist, the Subscriptions feed and History; the playlist and Subscriptions pages each get tiles for the other two, the home page gets all three, and every other YouTube page gets Playlist and Subscriptions. Each tile carries its own icon.

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this folder

## How it works

- Content script injected in the page's MAIN world on `youtube.com`
- State detection: `POST /youtubei/v1/browse` with `browseId: VLWL` - lists the Watch Later playlist and tests the current video id against it. The ids are cached for 5 minutes and patched on each toggle, so a normal browsing session costs one listing
- Toggle: `POST /youtubei/v1/browse/edit_playlist` with `ACTION_ADD_VIDEO` / `ACTION_REMOVE_VIDEO_BY_VIDEO_ID` against playlist `WL`
- Auth: the page's own cookies plus a `SAPISIDHASH` Authorization header; API key and client context read from `window.ytcfg`
- SPA-aware: re-rendered on every `yt-navigate-finish` event; hidden when logged out
- Page-aware: on a watch page hovering the button drops down three same-sized link tiles - Playlist, Subscriptions, History. On the Watch Later playlist and the Subscriptions feed there is no video to toggle, so the widget is just the tiles for the other two pages, always visible. The home page shows all three at once. Everywhere else - channels, search, Shorts, History itself - Playlist and Subscriptions show at once, with no hover needed. Each tile has a distinct icon (a queue for Playlist, stacked screens for Subscriptions, a rewind clock for History), drawn as inline SVG node by node because YouTube's Trusted Types policy rejects `innerHTML`. Embedded players are the one exception and get nothing
- The tiles are real anchors, so middle-click and ctrl-click open them in a new tab
- Card buttons: one button follows the pointer from thumbnail to thumbnail rather than one being injected into every card. It is fixed-position and lives outside `ytd-app`, so YouTube reshuffling its renderers cannot break it, nothing needs re-decorating when cards are recycled on scroll, and it paints over the inline preview player by z-index alone
- Thumbnails are found by href (`a[href*="/watch?v="]`) rather than renderer tag name, so both YouTube markup generations work - the older `ytd-thumbnail` and the newer `yt-lockup-view-model`. An image test and a size floor separate a real thumbnail from the title link beside it and from the invisible description links that also wrap an image. A link that wraps another watch link is skipped too: the playlist panel beside a watch page wraps each whole row, drag handle included, in one, and matching it put the cover over the handle
- One in-flight edit per video, shared by both buttons, so a double-click cannot race an add against a remove

## States

| Button | Meaning |
|---|---|
| `+ Watch Later` (dark) | not in the playlist - click to add |
| `In Watch Later` (green) | in the playlist - click to remove |
| `Watch Later...` (dimmed) | checking / call in flight |
| `Failed - try again` (red) | last toggle failed, state reverted |
| `Watch Later` (dimmed, red text) | state check failed - click to retry |

The card button carries the same states. On small thumbnails (sidebar, playlist panel) it covers the left half; on large ones (120px tall and up - feed and search grids) only the top-left quarter, so the preview's scrub bar stays reachable all the way across:

| Card button | Meaning |
|---|---|
| `+` (dark) | not in the playlist - click to add |
| `✓` (green) | in the playlist - click to remove |
| `…` (dimmed) | checking, first hover only while the id cache warms |
| `!` (red) | last toggle failed, state reverted |
| `⟳` (dimmed, red text) | state check failed - click to retry |

It is drawn as a gradient rather than a flat fill so the preview underneath stays watchable, and the right half of the thumbnail is left clear so clicking through to the video still works. Clicking `Failed - try again` (or `!`) retries the edit that failed.

## Links

| Page | Widget |
|---|---|
| `/watch` | toggle button; hover reveals `Playlist`, `Subscriptions`, `History` |
| `/playlist?list=WL` | `Subscriptions` and `History` |
| `/feed/subscriptions` | `Playlist` and `History` |
| `/` (home) | `Playlist`, `Subscriptions` and `History` |
| any other page | `Playlist` and `Subscriptions`, both always visible |
| `/embed/*` | nothing |

Middle-click or ctrl-click a tile to open it in a new tab. On watch pages the tiles are hidden and click-through until hovered, so they never block the page.

## Caveats

- Uses YouTube's unofficial InnerTube API - stable for years, but YouTube can change it without notice
- Membership is read by listing Watch Later, capped at 50 pages (~5000 videos); a video beyond that shows as not saved, and the console says so when the cap is hit
- The id cache is 5 minutes, so a video saved from another tab or from YouTube's own menu may show stale state until it expires
- Needs Chrome 111+ (`minimum_chrome_version`), the first version to honour `"world": "MAIN"` on a manifest content script, which the auth depends on
- Chrome only tested (Manifest V3); should work in Edge/Brave too
