// Small tolerant HTML extractor (no dependencies). Not a full HTML5 parser:
// it pulls out what the detectors need - links, buttons, forms, iframes, scripts,
// meta, JSON-LD, legacy-markup counters, visible text - and never executes anything.

const SKIP_TEXT = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head', 'title']);
const MOUNT_IDS = new Set(['root', 'app', '__next', '__nuxt', '___gatsby', 'svelte']);
const LEGACY_TAGS = new Set(['font', 'center', 'marquee', 'blink', 'frameset', 'frame', 'applet', 'bgsound']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', copy: '©' };

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function parseAttrs(str) {
  const attrs = {};
  const re = /([^\s=\/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    const name = m[1].toLowerCase();
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    if (!(name in attrs)) attrs[name] = decodeEntities(val);
  }
  return attrs;
}

function resolve(href, base) {
  if (href == null) return { resolved: null, scheme: null };
  const h = String(href).trim();
  const schemeMatch = h.match(/^([a-z][a-z0-9+.-]*):/i);
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : (h.startsWith('#') ? 'fragment' : 'relative');
  if (['tel', 'mailto', 'javascript', 'sms', 'whatsapp', 'fragment'].includes(scheme)) return { resolved: null, scheme };
  try { return { resolved: new URL(h, base).toString(), scheme: schemeMatch ? scheme : 'relative' }; }
  catch { return { resolved: null, scheme: 'invalid' }; }
}

export function parseHtml(html, baseUrl) {
  const src = String(html || '');
  const out = {
    title: null, doctype: null, metas: [], links: [], buttons: [], iframes: [], scripts: [], forms: [], linkTags: [],
    jsonLd: [], tagCounts: {}, legacy: { fontTags: 0, centerTags: 0, marquee: 0, blink: 0, frames: 0, flash: 0, bgcolorAttrs: 0, other: 0 },
    text: '', textLength: 0, noscriptText: '', generator: null, hasMountPoint: false, hasCharset: false,
    hasObfuscatedEmail: /data-cfemail|cdn-cgi\/l\/email-protection/i.test(src),
    isHtmlDocument: /<html[\s>]|<body[\s>]|<head[\s>]|<!doctype html/i.test(src),
    isJsShell: false,
  };
  const tagRe = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![a-zA-Z][^>]*>|<\?[\s\S]*?\?>|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  const skip = {};
  const textParts = [];
  let anchor = null;
  let button = null;
  let form = null;
  let inTitle = false;
  let headerDepth = 0;
  let navDepth = 0;
  let last = 0;
  let m;

  const onText = (raw) => {
    if (!raw) return;
    const t = decodeEntities(raw).replace(/\s+/g, ' ');
    if (!t.trim()) { if (anchor) anchor.text += ' '; if (button) button.text += ' '; return; }
    if (inTitle) { out.title = ((out.title || '') + t).trim(); return; }
    if (skip.noscript) { out.noscriptText += t; return; }
    if (Object.values(skip).some((v) => v > 0)) return;
    textParts.push(t);
    if (anchor) anchor.text += t;
    if (button) button.text += t;
    if (form) form.text += t;
  };

  while ((m = tagRe.exec(src)) !== null) {
    onText(src.slice(last, m.index));
    last = tagRe.lastIndex;
    if (m[0].startsWith('<!') || m[0].startsWith('<?')) {
      if (/^<!doctype/i.test(m[0])) out.doctype = m[0];
      continue;
    }
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const raw = m[0];
    const selfClosing = /\/\s*>$/.test(raw);

    if (closing) {
      if (name === 'a' && anchor) {
        if (!anchor.text.trim()) anchor.text = anchor.attrs['aria-label'] || anchor.attrs.title || '';
        anchor = null;
      } else if (name === 'button') button = null;
      else if (name === 'form') form = null;
      else if (name === 'title') inTitle = false;
      else if (name === 'header' && headerDepth > 0) headerDepth--;
      else if (name === 'nav' && navDepth > 0) navDepth--;
      else if (SKIP_TEXT.has(name) && skip[name] > 0) skip[name]--;
      continue;
    }

    const attrs = parseAttrs(m[3] || '');
    out.tagCounts[name] = (out.tagCounts[name] || 0) + 1;
    if (attrs.id && MOUNT_IDS.has(attrs.id.toLowerCase())) out.hasMountPoint = true;
    if ('bgcolor' in attrs) out.legacy.bgcolorAttrs++;
    if (LEGACY_TAGS.has(name)) {
      if (name === 'font') out.legacy.fontTags++;
      else if (name === 'center') out.legacy.centerTags++;
      else if (name === 'marquee') out.legacy.marquee++;
      else if (name === 'blink') out.legacy.blink++;
      else if (name === 'frameset' || name === 'frame') out.legacy.frames++;
      else out.legacy.other++;
    }
    if ((name === 'embed' && /\.swf(\?|$)|x-shockwave-flash/i.test(`${attrs.src || ''} ${attrs.type || ''}`)) ||
        (name === 'object' && /x-shockwave-flash|\.swf(\?|$)|d27cdb6e/i.test(`${attrs.type || ''} ${attrs.data || ''} ${attrs.classid || ''}`))) {
      out.legacy.flash++;
    }

    switch (name) {
      case 'a': {
        if (attrs.href === undefined) break;
        const { resolved, scheme } = resolve(attrs.href, baseUrl);
        anchor = { href: attrs.href, resolved, scheme, text: '', openTag: raw, attrs, index: out.links.length, inHeader: headerDepth > 0, inNav: navDepth > 0 };
        out.links.push(anchor);
        break;
      }
      case 'img':
        if (anchor && attrs.alt) anchor.text += ' ' + attrs.alt;
        break;
      case 'button': {
        button = { text: '', openTag: raw, index: out.links.length, inHeader: headerDepth > 0, inNav: navDepth > 0 };
        out.buttons.push(button);
        if (form && (!attrs.type || attrs.type.toLowerCase() === 'submit')) form.hasSubmit = true;
        break;
      }
      case 'iframe': {
        const { resolved } = resolve(attrs.src, baseUrl);
        out.iframes.push({ src: attrs.src || '', resolved, html: raw });
        break;
      }
      case 'script': {
        let inlineLength = 0;
        let inlineText = '';
        if (!selfClosing) {
          const close = src.slice(last).search(/<\/script\s*>/i);
          const end = close < 0 ? src.length : last + close;
          inlineText = src.slice(last, end);
          inlineLength = inlineText.length;
          const after = close < 0 ? src.length : end + src.slice(end).match(/<\/script\s*>/i)[0].length;
          last = after;
          tagRe.lastIndex = after;
        }
        if (/ld\+json/i.test(attrs.type || '') && inlineText.trim()) out.jsonLd.push(inlineText.trim().slice(0, 50_000));
        const { resolved } = resolve(attrs.src, baseUrl);
        out.scripts.push({ src: attrs.src || null, resolved, inlineLength, html: raw });
        continue;
      }
      case 'style': {
        if (!selfClosing) {
          const close = src.slice(last).search(/<\/style\s*>/i);
          const end = close < 0 ? src.length : last + close;
          const after = close < 0 ? src.length : end + src.slice(end).match(/<\/style\s*>/i)[0].length;
          last = after;
          tagRe.lastIndex = after;
        }
        continue;
      }
      case 'meta':
        out.metas.push(attrs);
        if ((attrs.name || '').toLowerCase() === 'generator') out.generator = attrs.content || null;
        if (attrs.charset || /content-type/i.test(attrs['http-equiv'] || '')) out.hasCharset = true;
        break;
      case 'link': {
        const { resolved } = resolve(attrs.href, baseUrl);
        out.linkTags.push({ ...attrs, resolved });
        break;
      }
      case 'form':
        form = { action: attrs.action || '', method: (attrs.method || 'get').toLowerCase(), attrs, inputs: [], textareas: 0, selects: 0, hasSubmit: false, text: '', openTag: raw };
        out.forms.push(form);
        break;
      case 'input': {
        const type = (attrs.type || 'text').toLowerCase();
        if (form) {
          form.inputs.push({ type, name: (attrs.name || '').toLowerCase(), placeholder: attrs.placeholder || '' });
          if (type === 'submit' || type === 'image') form.hasSubmit = true;
        }
        if ((type === 'submit' || type === 'button') && attrs.value) {
          out.buttons.push({ text: attrs.value, openTag: raw, index: out.links.length, inHeader: headerDepth > 0, inNav: navDepth > 0 });
        }
        break;
      }
      case 'textarea': if (form) form.textareas++; break;
      case 'select': if (form) form.selects++; break;
      case 'title': inTitle = true; break;
      case 'header': if (!selfClosing) headerDepth++; break;
      case 'nav': if (!selfClosing) navDepth++; break;
      default: break;
    }
    if (SKIP_TEXT.has(name) && !selfClosing && name !== 'title') skip[name] = (skip[name] || 0) + 1;
  }
  onText(src.slice(last));

  out.text = textParts.join(' ').replace(/\s+/g, ' ').trim();
  out.textLength = out.text.length;
  const externalScripts = out.scripts.filter((s) => s.src).length;
  out.isJsShell = out.textLength < 300 && (
    out.hasMountPoint || externalScripts >= 2 || /enable javascript|javascript (is )?(required|disabled)/i.test(out.noscriptText)
  );
  return out;
}
