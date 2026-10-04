// Parser for MPEG-DASH manifests (MPD). Only the first Period is read.

import { parseXml, childOf, childrenOf } from './xml.js';

// Converts an ISO 8601 duration such as "PT1H2M3.5S" to seconds.
export function parseIsoDuration(value) {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(value || '');
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s] = m.map((v) => Number(v) || 0);
  return ((y * 365 + mo * 30 + d) * 24 + h) * 3600 + mi * 60 + s;
}

// Converts "first-last" to { offset, length }.
function parseRange(value) {
  const m = /^(\d+)-(\d+)$/.exec(value || '');
  return m ? { offset: Number(m[1]), length: Number(m[2]) - Number(m[1]) + 1 } : null;
}

// Replaces $RepresentationID$, $Number$, $Bandwidth$, $Time$ and $$.
export function fillTemplate(template, vars) {
  return template.replace(/\$(RepresentationID|Number|Bandwidth|Time)?(?:%0(\d+)d)?\$/g, (all, name, width) => {
    if (!name) return all === '$$' ? '$' : all;
    const value = String(vars[name]);
    return width ? value.padStart(Number(width), '0') : value;
  });
}

function templateSegments(rep, levels, base, periodDuration) {
  const templates = levels.map((l) => childOf(l, 'SegmentTemplate')).filter(Boolean);
  if (!templates.length) return false;
  // Attributes of the deeper element override the attributes of its parents.
  const a = Object.assign({}, ...templates.map((t) => t.attrs));
  const timeline = [...templates].reverse().map((t) => childOf(t, 'SegmentTimeline')).find(Boolean);
  const vars = { RepresentationID: rep.id, Bandwidth: rep.bandwidth };
  const url = (tpl, extra) => new URL(fillTemplate(tpl, { ...vars, ...extra }), base).href;
  if (!a.media) throw new Error('Unsupported DASH manifest: SegmentTemplate has no media attribute');
  if (a.initialization) rep.init = { url: url(a.initialization, {}), range: null };

  const timescale = Number(a.timescale) || 1;
  let number = a.startNumber !== undefined ? Number(a.startNumber) : 1;

  if (timeline) {
    const entries = childrenOf(timeline, 'S');
    let t = 0;
    entries.forEach((s, i) => {
      if (s.attrs.t !== undefined) t = Number(s.attrs.t);
      const d = Number(s.attrs.d);
      let repeat = Number(s.attrs.r) || 0;
      if (repeat < 0) {
        // A negative repeat count continues to the next entry or the period end.
        const next = entries[i + 1]?.attrs.t;
        const end = next !== undefined ? Number(next) : periodDuration * timescale;
        repeat = Number.isFinite(end) ? Math.max(0, Math.ceil((end - t) / d) - 1) : 0;
      }
      for (let k = 0; k <= repeat; k++) {
        rep.segments.push({ url: url(a.media, { Number: number, Time: t }), range: null });
        number++;
        t += d;
      }
    });
    return true;
  }

  if (a.duration) {
    let count;
    if (a.endNumber !== undefined) {
      count = Number(a.endNumber) - number + 1;
    } else if (Number.isFinite(periodDuration)) {
      count = Math.ceil((periodDuration * timescale) / Number(a.duration) - 1e-6);
    } else {
      throw new Error('Unsupported DASH manifest: the duration is unknown');
    }
    for (let k = 0; k < count; k++) {
      const seg = { url: url(a.media, { Number: number + k, Time: k * Number(a.duration) }), range: null };
      // The computed count can be one too high. The server then has no last segment.
      if (k === count - 1 && k > 0 && a.endNumber === undefined) seg.optional = true;
      rep.segments.push(seg);
    }
    return true;
  }
  throw new Error('Unsupported DASH manifest: SegmentTemplate has no timeline or duration');
}

function listSegments(rep, levels, base) {
  const list = [...levels].reverse().map((l) => childOf(l, 'SegmentList')).find(Boolean);
  if (!list) return false;
  const init = childOf(list, 'Initialization');
  if (init) {
    rep.init = { url: new URL(init.attrs.sourceURL || '', base).href, range: parseRange(init.attrs.range) };
  }
  for (const s of childrenOf(list, 'SegmentURL')) {
    rep.segments.push({ url: new URL(s.attrs.media || '', base).href, range: parseRange(s.attrs.mediaRange) });
  }
  return true;
}

export function parseMpd(text, mpdUrl) {
  const mpd = parseXml(text);
  if (mpd.name !== 'MPD') throw new Error('Not a DASH manifest');
  const periods = childrenOf(mpd, 'Period');
  if (!periods.length) throw new Error('DASH manifest has no Period');
  const period = periods[0];

  const total = parseIsoDuration(mpd.attrs.mediaPresentationDuration);
  const start = parseIsoDuration(period.attrs.start) || 0;
  let duration = parseIsoDuration(period.attrs.duration);
  if (!Number.isFinite(duration)) {
    const nextStart = periods[1] ? parseIsoDuration(periods[1].attrs.start) : NaN;
    if (Number.isFinite(nextStart)) duration = nextStart - start;
    else if (Number.isFinite(total)) duration = total - start;
  }

  const baseOf = (node, parent) => {
    const b = childOf(node, 'BaseURL');
    return b ? new URL(b.text.trim(), parent).href : parent;
  };
  const periodBase = baseOf(period, baseOf(mpd, mpdUrl));

  const representations = [];
  for (const set of childrenOf(period, 'AdaptationSet')) {
    const setBase = baseOf(set, periodBase);
    for (const node of childrenOf(set, 'Representation')) {
      const attr = (name) => node.attrs[name] ?? set.attrs[name];
      const mime = attr('mimeType') || '';
      const kind = (set.attrs.contentType || mime.split('/')[0] || '').toLowerCase();
      if (kind !== 'video' && kind !== 'audio') continue;
      const rep = {
        id: node.attrs.id || String(representations.length),
        kind,
        mime,
        codecs: attr('codecs') || '',
        bandwidth: Number(node.attrs.bandwidth) || 0,
        width: Number(attr('width')) || 0,
        height: Number(attr('height')) || 0,
        lang: set.attrs.lang || '',
        drm: Boolean(childOf(set, 'ContentProtection') || childOf(node, 'ContentProtection')),
        init: null,
        segments: [],
      };
      const levels = [period, set, node];
      const base = baseOf(node, setBase);
      if (!templateSegments(rep, levels, base, duration) && !listSegments(rep, levels, base)) {
        // SegmentBase or a plain BaseURL: the representation is one file.
        rep.segments.push({ url: base, range: null });
      }
      representations.push(rep);
    }
  }

  return {
    live: mpd.attrs.type === 'dynamic',
    duration: Number.isFinite(duration) ? duration : 0,
    multiPeriod: periods.length > 1,
    representations,
  };
}
