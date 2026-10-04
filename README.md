# Gannet

Gannet is a free video downloader extension for Chrome. It is an open source
replacement for Video DownloadHelper.

Gannet is free and will always be free. It has no download limits, no
account, no subscription, no companion application and no tracking. The code
has the MIT license.

The gannet is a seabird that dives into the water to catch fish. This
extension does the same with media streams.

## Features

- Detects media while you browse. The toolbar icon shows the number of media
  items found on the page.
- Downloads media files directly (MP4, WebM, MP3, M4A and others).
- Downloads HLS streams (`.m3u8`), including streams with AES-128 encryption
  and streams with a separate audio track.
- Downloads DASH streams (`.mpd`) with MP4 segments.
- Lets you select the video quality and the audio track.
- Converts fragmented MP4 streams to a standard MP4 file. Audio and video are
  combined into one file. The conversion does not encode the media again, so
  there is no quality loss.
- Sends the same `Referer` and `Origin` headers as the page, for servers that
  require them.
- Has no dependencies. All code is plain JavaScript in this repository.

## Installation

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the repository folder.

Chrome 116 or later is necessary.

## Use

1. Open a page that has a video.
2. Start the video. Most players load the media only after playback starts.
3. Click the Gannet icon.
4. Select the quality and click **Download**.

The file name is the title of the page. Chrome saves the file in your
downloads folder.

## Limits

- **DRM**: Gannet does not download media that has DRM protection (Widevine,
  PlayReady, FairPlay). It does not try to bypass DRM.
- **YouTube**: Gannet ignores YouTube. The Chrome Web Store policy does not
  permit extensions that download from YouTube.
- **Live streams**: not supported at this time.
- **MPEG-TS streams**: HLS streams with MPEG-TS segments are saved as a `.ts`
  file without conversion. VLC, mpv and most other players can play `.ts`
  files. If such a stream has a separate audio track, Gannet saves two files.
- **DASH**: only the first period of a manifest is downloaded. WebM segments
  are not supported.
- **Memory**: a stream is assembled in browser storage before Chrome saves
  it. Very large streams need free disk space for two copies during the save.

## Privacy

Gannet does not collect data. It sends no requests other than the requests
that are necessary to download the media that you select.

Gannet needs these permissions:

| Permission | Purpose |
| --- | --- |
| Access to all sites | To see media responses on any page and to fetch the media. |
| `webRequest` | To detect media in network responses. |
| `webNavigation` | To clear the media list when a tab opens a new page. |
| `downloads` | To save files. |
| `declarativeNetRequestWithHostAccess` | To set the `Referer` and `Origin` headers on the download requests of the extension. |
| `offscreen` | To assemble segments into a file in a hidden document. |
| `storage` | To keep the media list while the service worker is stopped. Session storage only. |

## How it works

| File | Function |
| --- | --- |
| `src/background.js` | Service worker. Detects media, keeps the state, starts downloads. |
| `src/offscreen.js` | Hidden document that runs the download engine. |
| `src/popup/` | The popup window. |
| `src/lib/detect.js` | Rules that classify a network response. |
| `src/lib/hls.js` | HLS playlist parser. |
| `src/lib/dash.js`, `src/lib/xml.js` | DASH manifest parser. |
| `src/lib/manifest.js` | Converts a manifest to a quality list and a download plan. |
| `src/lib/engine.js` | Fetches segments, decrypts AES-128, assembles the output. |
| `src/lib/mp4.js` | Converts fragmented MP4 to standard MP4. |

## Development

Node.js 22 or later is necessary for the tests. There is no build step.

```sh
npm test                    # Unit tests
npm run e2e                 # End-to-end test in headless Chrome
npm run icons               # Draw the icons again
npm run pack                # Build dist/gannet-<version>.zip for release
```

The ZIP from `npm run pack` contains only `manifest.json`, `LICENSE`, `icons/`
and `src/`. It is the file to upload to the Chrome Web Store.

### Release

A GitHub Actions workflow publishes a release when a version tag is pushed.

1. Set the new version in `manifest.json` and in `package.json`.
2. Commit and push the change.
3. Tag the commit and push the tag:

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

The workflow stops if the tag does not agree with the two version numbers.
It then runs the unit tests, builds the ZIP and attaches it to a new GitHub
release.

`tools/fetch-stream.mjs` downloads a stream from the command line with the
same engine as the extension:

```sh
node tools/fetch-stream.mjs https://example.com/stream/master.m3u8 output
```

## Legal

Download only media that you have the right to download. You are responsible
for compliance with copyright law and with the terms of the sites that you
use.

## License

[MIT](LICENSE)
