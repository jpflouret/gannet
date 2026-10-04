import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml } from '../src/lib/xml.js';
import { parseIsoDuration, fillTemplate, parseMpd } from '../src/lib/dash.js';

const URL_MPD = 'https://cdn.example.com/dash/manifest.mpd';

test('parseXml reads elements, attributes, entities and CDATA', () => {
  const root = parseXml(
    '<?xml version="1.0"?><!-- note --><a x="1" ns:y=\'a &amp; b > c\'><b/><ns:c>t&lt;1<![CDATA[<raw>]]></ns:c></a>',
  );
  assert.equal(root.name, 'a');
  assert.deepEqual(root.attrs, { x: '1', y: 'a & b > c' });
  assert.deepEqual(root.children.map((c) => c.name), ['b', 'c']);
  assert.equal(root.children[1].text, 't<1<raw>');
});

test('parseIsoDuration converts to seconds', () => {
  assert.equal(parseIsoDuration('PT1H2M3.5S'), 3723.5);
  assert.equal(parseIsoDuration('PT634.566S'), 634.566);
  assert.equal(parseIsoDuration('P1DT1S'), 86401);
  assert.ok(Number.isNaN(parseIsoDuration('bad')));
});

test('fillTemplate replaces identifiers', () => {
  const vars = { RepresentationID: 'v1', Number: 7, Bandwidth: 5000, Time: 90000 };
  assert.equal(fillTemplate('$RepresentationID$/seg-$Number%05d$.m4s', vars), 'v1/seg-00007.m4s');
  assert.equal(fillTemplate('t$Time$_$Bandwidth$_$$', vars), 't90000_5000_$');
});

test('parseMpd expands a SegmentTemplate with a duration', () => {
  const mpd = `<?xml version="1.0"?>
  <MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10S">
    <Period>
      <AdaptationSet mimeType="video/mp4" codecs="avc1.64001f">
        <SegmentTemplate timescale="1000" duration="4000" startNumber="1"
          initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/$Number$.m4s"/>
        <Representation id="hd" bandwidth="3000000" width="1280" height="720"/>
      </AdaptationSet>
      <AdaptationSet contentType="audio" lang="en">
        <Representation id="aac" bandwidth="128000" mimeType="audio/mp4">
          <BaseURL>audio/</BaseURL>
          <SegmentTemplate timescale="48000" initialization="init.mp4" media="$Time$.m4s">
            <SegmentTimeline><S t="0" d="96000" r="2"/><S d="48000"/></SegmentTimeline>
          </SegmentTemplate>
        </Representation>
      </AdaptationSet>
      <AdaptationSet mimeType="text/vtt"><Representation id="sub" bandwidth="1"/></AdaptationSet>
    </Period>
  </MPD>`;
  const out = parseMpd(mpd, URL_MPD);
  assert.equal(out.live, false);
  assert.equal(out.duration, 10);
  assert.equal(out.representations.length, 2);

  const [video, audio] = out.representations;
  assert.equal(video.kind, 'video');
  assert.equal(video.height, 720);
  assert.equal(video.codecs, 'avc1.64001f');
  assert.equal(video.init.url, 'https://cdn.example.com/dash/hd/init.mp4');
  assert.deepEqual(video.segments.map((s) => s.url), [
    'https://cdn.example.com/dash/hd/1.m4s',
    'https://cdn.example.com/dash/hd/2.m4s',
    'https://cdn.example.com/dash/hd/3.m4s',
  ]);
  assert.equal(video.segments[2].optional, true);

  assert.equal(audio.kind, 'audio');
  assert.equal(audio.lang, 'en');
  assert.equal(audio.init.url, 'https://cdn.example.com/dash/audio/init.mp4');
  assert.deepEqual(audio.segments.map((s) => s.url), [
    'https://cdn.example.com/dash/audio/0.m4s',
    'https://cdn.example.com/dash/audio/96000.m4s',
    'https://cdn.example.com/dash/audio/192000.m4s',
    'https://cdn.example.com/dash/audio/288000.m4s',
  ]);
});

test('parseMpd reads a single-file representation and DRM', () => {
  const mpd = `<MPD type="static" mediaPresentationDuration="PT1M">
    <BaseURL>https://media.example.org/x/</BaseURL>
    <Period>
      <AdaptationSet mimeType="video/mp4">
        <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>
        <Representation id="1" bandwidth="100">
          <BaseURL>video.mp4</BaseURL>
          <SegmentBase indexRange="800-1200"><Initialization range="0-799"/></SegmentBase>
        </Representation>
      </AdaptationSet>
    </Period>
  </MPD>`;
  const [rep] = parseMpd(mpd, URL_MPD).representations;
  assert.equal(rep.drm, true);
  assert.equal(rep.init, null);
  assert.deepEqual(rep.segments, [{ url: 'https://media.example.org/x/video.mp4', range: null }]);
});

test('parseMpd reads a SegmentList and the live flag', () => {
  const mpd = `<MPD type="dynamic">
    <Period>
      <AdaptationSet mimeType="audio/mp4">
        <Representation id="a" bandwidth="64000">
          <SegmentList>
            <Initialization sourceURL="a.mp4" range="0-99"/>
            <SegmentURL media="a.mp4" mediaRange="100-299"/>
            <SegmentURL media="a.mp4" mediaRange="300-349"/>
          </SegmentList>
        </Representation>
      </AdaptationSet>
    </Period>
  </MPD>`;
  const out = parseMpd(mpd, URL_MPD);
  assert.equal(out.live, true);
  const [rep] = out.representations;
  assert.deepEqual(rep.init, { url: 'https://cdn.example.com/dash/a.mp4', range: { offset: 0, length: 100 } });
  assert.deepEqual(rep.segments[1], { url: 'https://cdn.example.com/dash/a.mp4', range: { offset: 300, length: 50 } });
});
