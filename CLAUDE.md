# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Gannet is a Chrome extension (Manifest V3) that downloads media files, HLS streams and DASH streams. It is a free, MIT-licensed replacement for Video DownloadHelper. The project has no dependencies and no build step. Chrome loads the files in the repository directly as ES modules.

## Commands

```sh
npm test                                   # Unit tests (node --test, finds tests/*.test.js)
node --test tests/mp4.test.js              # One test file
node --test --test-name-pattern="defragment" tests/mp4.test.js   # One test by name
npm run e2e                                # End-to-end test in headless Chrome
npm run icons                              # Draw icons/*.png again from tools/make-icons.mjs
npm run pack                               # Build dist/gannet-<version>.zip (manifest.json, LICENSE, icons/, src/)
node tools/fetch-stream.mjs <manifest-url> [output-name] [--lowest]   # Run the engine from the command line
```

- Node.js 22 or later is necessary. There is no linter and no bundler.
- `npm run e2e` needs Chrome. Set `CHROME_PATH` if Chrome is not in a default location. Set `E2E_SCREENSHOT=<file.png>` to save a screenshot of the popup. Set `EXTENSION_DIR=<folder>` to test another copy of the extension, for example the extracted ZIP.
- The version number is in `manifest.json` and in `package.json`. Change both for a release. `tools/pack.mjs` reads the version from `manifest.json`.
- A pushed tag `v<version>` starts `.github/workflows/release.yml`. The workflow fails if the tag does not agree with both version numbers. It then runs `npm test` and `npm run pack`, and publishes a GitHub release with the ZIP. It does not run the end-to-end test.
- To try the extension by hand, load the repository folder with **Load unpacked** at `chrome://extensions`.
- The Node test runner collects all files named `*.test.js` or `*-test.mjs` in the repository. Do not give such a name to a script in `tools/`, or `npm test` will start it.

## Architecture

The extension has three contexts. They communicate with `chrome.runtime.sendMessage`. Each message has a `target` field (`'bg'` or `'offscreen'`), and each listener ignores messages for other targets.

1. **Service worker** (`src/background.js`). Detects media, owns all state, plans downloads, calls `chrome.downloads`.
2. **Offscreen document** (`src/offscreen.js`). Runs the download engine and returns blob URLs. It exists because a service worker cannot call `URL.createObjectURL`. The service worker creates it when an engine job starts and closes it when no engine job is active.
3. **Popup** (`src/popup/`). Polls the service worker with `get-state` every 600 ms and draws the media list and the jobs. It keeps no state of its own.

### Shared library (`src/lib/`)

The files in `src/lib/` use only web platform APIs (`fetch`, `Blob`, WebCrypto). They must not use `chrome.*` and must not use `DOMParser` (the service worker has none, which is why `xml.js` exists). This rule lets the same code run in the service worker, in the offscreen document, in the unit tests and in `tools/fetch-stream.mjs`.

The data flows through the library in this order:

- `detect.js` classifies a response as `'hls'`, `'dash'`, `'file'` or nothing.
- `hls.js` and `dash.js` parse manifests.
- `manifest.js` converts a parsed manifest to two forms:
  - `probeManifest()` returns `info`: the quality list (`videos`, `audios`) and the `live`, `drm` and `duration` values that the popup shows. The ids in `info` are indexes into the parsed manifest, so `planTracks()` can find the same entry after it fetches the manifest again.
  - `planTracks()` returns `tracks`: `[{ role, init, segments: [{ url, range, key, seq, optional }] }]`. This plan is plain JSON. The service worker makes it and sends it to the offscreen document.
- `engine.js` (`runDownload`) fetches all segments of a plan, decrypts AES-128 segments, and assembles the output files.
- `mp4.js` (`defragment`) converts fragmented MP4 to a standard MP4. It reads the `moof` sample tables and writes one `moov` box. The output Blob refers to slices of the input Blobs, so sample data is not copied in memory. If the conversion fails, the engine saves the segments joined as they are.

### Detection

`webRequest.onHeadersReceived` classifies each response. `onSendHeaders` records the `Referer` of each request so that the download can send the same value. For a manifest, the service worker fetches it immediately (`probe`) to get the quality list. Media playlists that belong to a detected master playlist are hidden through `info.children`. Players that use Media Source Extensions fetch many numbered files; `isSegmentSpam` removes them when three paths have the same digit pattern.

### Download paths

- **File**: `chrome.downloads.download` with the original URL. If Chrome reports an interruption (for example HTTP 403 because the server requires a `Referer`), `retryWithEngine` fetches the file with the engine as a one-segment plan with `raw` set.
- **HLS and DASH**: `planTracks` in the service worker, then `start-job` to the offscreen document, then `job-output` with blob URLs, then `chrome.downloads.download` for each blob URL.

### State and service worker lifetime

Chrome can stop the service worker at any time. All state (`media`, `jobs`, `downloads`, `seq`) is in one object that is saved to `chrome.storage.session` with a short delay. All event listeners are registered at the top level of the module, and each handler waits for the `ready` promise before it reads the state. Keep this pattern for new listeners. `state.seq` is the one source of ids for media items, jobs and header rules.

### Request headers

Servers frequently refuse requests that do not have the `Referer` and `Origin` of their page. `setHeaderRule` adds a `declarativeNetRequest` session rule that sets these headers on requests from the extension (`initiatorDomains` is the extension id, `tabIds` is `TAB_ID_NONE`) to a list of hosts. The rule id of a job is the job id. `fetchContext` adds each new host to the rule before the first request to that host. Rules must be removed when a probe or a job ends; the end-to-end test checks that none remain.

## Facts that are easy to get wrong

- A blob URL given to `chrome.downloads` must have the type `application/octet-stream`. With an empty type, Chrome saves the file with a `.txt` extension. `offscreen.js` sets the type.
- In the end-to-end test, do not call the DevTools command `Browser.setDownloadBehavior`. It overrides the file names from `chrome.downloads`. The test sets the download folder in the profile preferences.
- Chrome does not load `<video>` media in background tabs. The end-to-end test opens the test page last so that it is the foreground tab.
- `popup.html?tabId=<id>` makes the popup show the given tab. The end-to-end test uses this to open the popup as a normal page.
- `Extensions.loadUnpacked` works only with `--remote-debugging-pipe` and `--enable-unsafe-extension-debugging`. The `--load-extension` switch does not work in current Chrome builds.

## Product decisions

These are deliberate. Do not change them without a request from the user.

- No DRM bypass. HLS keys other than AES-128 with the `identity` key format, DASH `ContentProtection`, and `encv`/`enca` sample entries are refused with a clear message.
- YouTube hosts are ignored (`isIgnoredHost` in `detect.js`) because the Chrome Web Store policy does not permit downloads from YouTube.
- No runtime dependencies, no build step, no telemetry.
- Live streams, MPEG-TS to MP4 conversion, DASH periods after the first, and WebM DASH segments are not implemented. `README.md` lists these limits; update it when one changes.
