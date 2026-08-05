# Watch Later Toggle

Chrome extension: a single button, top-right of every YouTube watch page, that adds or removes the current video from your Watch Later playlist. Detects membership on load and shows the correct state.

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this folder

## How it works

- Content script injected in the page's MAIN world on `youtube.com`
- State detection: `POST /youtubei/v1/browse` with `browseId: VLWL` - lists the Watch Later playlist and tests the current video id against it. The ids are cached for 5 minutes and patched on each toggle, so a normal browsing session costs one listing
- Toggle: `POST /youtubei/v1/browse/edit_playlist` with `ACTION_ADD_VIDEO` / `ACTION_REMOVE_VIDEO_BY_VIDEO_ID` against playlist `WL`
- Auth: the page's own cookies plus a `SAPISIDHASH` Authorization header; API key and client context read from `window.ytcfg`
- SPA-aware: re-checks state on every `yt-navigate-finish` event; hidden on non-watch pages and when logged out

## States

| Button | Meaning |
|---|---|
| `+ Watch Later` (dark) | not in the playlist - click to add |
| `In Watch Later` (green) | in the playlist - click to remove |
| `Watch Later...` (dimmed) | checking / call in flight |
| `Failed - try again` (red) | last toggle failed, state reverted |
| `Watch Later` (dimmed, red text) | state check failed - click to retry |

## Caveats

- Uses YouTube's unofficial InnerTube API - stable for years, but YouTube can change it without notice
- Membership is read by listing Watch Later, capped at 20 pages (~2000 videos); a video beyond that shows as not saved
- Chrome only tested (Manifest V3); should work in Edge/Brave too
