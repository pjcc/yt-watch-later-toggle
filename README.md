# Watch Later Toggle

Chrome extension: a single button, top-right of every YouTube watch page, that adds or removes the current video from your Watch Later playlist. Detects membership on load and shows the correct state. Hovering it reveals quick links to the Watch Later playlist and the Subscriptions feed, and those two pages each get a tile linking to the other.

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
- Page-aware: on a watch page hovering the button drops down two same-sized link tiles - Playlist, then Subscriptions. On the Watch Later playlist and the Subscriptions feed there is no video to toggle, so the widget is just the one tile linking to the other page. Every other page gets nothing
- The tiles are real anchors, so middle-click and ctrl-click open them in a new tab

## States

| Button | Meaning |
|---|---|
| `+ Watch Later` (dark) | not in the playlist - click to add |
| `In Watch Later` (green) | in the playlist - click to remove |
| `Watch Later...` (dimmed) | checking / call in flight |
| `Failed - try again` (red) | last toggle failed, state reverted |
| `Watch Later` (dimmed, red text) | state check failed - click to retry |

## Links

| Page | Widget |
|---|---|
| `/watch` | toggle button; hover reveals `Playlist` then `Subscriptions` |
| `/playlist?list=WL` | a single `Subscriptions` tile |
| `/feed/subscriptions` | a single `WL Playlist` tile |

Middle-click or ctrl-click a tile to open it in a new tab. On watch pages the tiles are hidden and click-through until hovered, so they never block the page.

## Caveats

- Uses YouTube's unofficial InnerTube API - stable for years, but YouTube can change it without notice
- Membership is read by listing Watch Later, capped at 20 pages (~2000 videos); a video beyond that shows as not saved
- Keyboard focus opens the hover strip via `:has(:focus-visible)`, which needs Chrome 105+; on anything older only the mouse path works
- Chrome only tested (Manifest V3); should work in Edge/Brave too
