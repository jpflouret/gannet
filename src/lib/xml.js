// Minimal XML parser. It is sufficient for DASH manifests and works in a
// service worker, where DOMParser is not available.
//
// Each node is { name, attrs, children, text }. Namespace prefixes are
// removed from element and attribute names.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, ref) => {
    if (ref[0] === '#') {
      const code = ref[1].toLowerCase() === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[ref.toLowerCase()] ?? all;
  });
}

const localName = (name) => name.slice(name.indexOf(':') + 1);

// Index of the '>' that closes the tag starting at 'from'. Skips quoted text.
function findTagEnd(text, from) {
  let quote = '';
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  return -1;
}

function parseAttrs(str) {
  const attrs = {};
  const re = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(str))) {
    attrs[localName(m[1])] = decodeEntities(m[2] ?? m[3]);
  }
  return attrs;
}

export function parseXml(text) {
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const n = text.length;
  let i = 0;
  const skipTo = (marker, from) => {
    const end = text.indexOf(marker, from);
    return end < 0 ? n : end + marker.length;
  };

  while (i < n) {
    const lt = text.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt < 0) {
      top.text += decodeEntities(text.slice(i));
      break;
    }
    if (lt > i) top.text += decodeEntities(text.slice(i, lt));

    if (text.startsWith('<!--', lt)) {
      i = skipTo('-->', lt + 4);
    } else if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      top.text += text.slice(lt + 9, end < 0 ? n : end);
      i = end < 0 ? n : end + 3;
    } else if (text.startsWith('<?', lt)) {
      i = skipTo('?>', lt + 2);
    } else if (text.startsWith('<!', lt)) {
      i = skipTo('>', lt + 2);
    } else {
      const gt = findTagEnd(text, lt + 1);
      if (gt < 0) throw new Error('Malformed XML');
      let body = text.slice(lt + 1, gt);
      i = gt + 1;
      if (body[0] === '/') {
        const name = localName(body.slice(1).trim());
        for (let d = stack.length - 1; d > 0; d--) {
          if (stack[d].name === name) {
            stack.length = d;
            break;
          }
        }
        continue;
      }
      const selfClosing = body.endsWith('/');
      if (selfClosing) body = body.slice(0, -1);
      const nameMatch = /^[^\s]+/.exec(body);
      if (!nameMatch) throw new Error('Malformed XML');
      const node = {
        name: localName(nameMatch[0]),
        attrs: parseAttrs(body.slice(nameMatch[0].length)),
        children: [],
        text: '',
      };
      top.children.push(node);
      if (!selfClosing) stack.push(node);
    }
  }
  if (!root.children.length) throw new Error('Empty XML document');
  return root.children[0];
}

export const childrenOf = (node, name) => node.children.filter((c) => c.name === name);
export const childOf = (node, name) => node.children.find((c) => c.name === name);
