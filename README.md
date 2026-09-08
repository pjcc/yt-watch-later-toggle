# Watch Later Toggle

Chrome extension for Watch Later. A button top-right of every YouTube watch page adds or removes the current video, and hovering any video thumbnail anywhere on YouTube gives you the same toggle for that video. Both detect membership first, so they show whether the video is already saved before you click. Hovering the watch-page button reveals quick links to the Watch Later playlist and the Subscriptions feed; those two pages each get a tile linking to the other, and every other YouTube page gets both.

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
- Page-aware: on a watch page hovering the button drops down two same-sized link tiles - Playlist, then Subscriptions. On the Watch Later playlist and the Subscriptions feed there is no video to toggle, so the widget is just the one tile linking to the other page. Everywhere else - home, channels, search, Shorts - both tiles show at once, with no hover needed. Embedded players are the one exception and get nothing
- The tiles are real anchors, so middle-click and ctrl-click open them in a new tab
- Card buttons: one button follows the pointer from thumbnail to thumbnail rather than one being injected into every card. It is fixed-position and lives outside `ytd-app`, so YouTube reshuffling its renderers cannot break it, nothing needs re-decorating when cards are recycled on scroll, and it paints over the inline preview player by z-index alone
- Thumbnails are found by href (`a[href*="/watch?v="]`) rather than renderer tag name, so both YouTube markup generations work - the older `ytd-thumbnail` and the newer `yt-lockup-view-model`. An image test and a size floor separate a real thumbnail from the title link beside it and from the invisible description links that also wrap an image

## States

| Button | Meaning |
|---|---|
| `+ Watch Later` (dark) | not in the playlist - click to add |
| `In Watch Later` (green) | in the playlist - click to remove |
| `Watch Later...` (dimmed) | checking / call in flight |
| `Failed - try again` (red) | last toggle failed, state reverted |
| `Watch Later` (dimmed, red text) | state check failed - click to retry |

The card button carries the same states in miniature, top-left of the thumbnail on hover:

| Card button | Meaning |
|---|---|
| `+` (dark) | not in the playlist - click to add |
| `✓` (green) | in the playlist - click to remove |
| `…` (dimmed) | checking, first hover only while the id cache warms |
| `!` (red) | last toggle failed, state reverted |
| `⟳` (dimmed, red text) | state check failed - click to retry |

## Links

| Page | Widget |
|---|---|
| `/watch` | toggle button; hover reveals `Playlist` then `Subscriptions` |
| `/playlist?list=WL` | a single `Subscriptions` tile |
| `/feed/subscriptions` | a single `WL Playlist` tile |
| any other page | `WL Playlist` and `Subscriptions`, both always visible |
| `/embed/*` | nothing |

Middle-click or ctrl-click a tile to open it in a new tab. On watch pages the tiles are hidden and click-through until hovered, so they never block the page.

## Caveats

- Uses YouTube's unofficial InnerTube API - stable for years, but YouTube can change it without notice
- Membership is read by listing Watch Later, capped at 50 pages (~5000 videos); a video beyond that shows as not saved, and the console says so when the cap is hit
- The id cache is 5 minutes, so a video saved from another tab or from YouTube's own menu may show stale state until it expires
- Keyboard focus opens the hover strip via `:has(:focus-visible)`, which needs Chrome 105+; on anything older only the mouse path works
- Chrome only tested (Manifest V3); should work in Edge/Brave too
