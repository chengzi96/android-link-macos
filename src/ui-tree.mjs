import crypto from 'node:crypto';

const TEXT_LIMIT = 160;
const MAX_SUMMARY_ELEMENTS = 120;

function decodeXml(value = '') {
  return String(value).replace(/&#(x?[0-9a-f]+);|&(amp|quot|apos|lt|gt);/gi, (match, numeric, named) => {
    if (numeric) {
      const code = Number.parseInt(numeric.replace(/^x/i, ''), /^x/i.test(numeric) ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    }
    return {amp: '&', quot: '"', apos: "'", lt: '<', gt: '>'}[String(named).toLowerCase()] || '';
  });
}

export function redactUiText(value, limit = TEXT_LIMIT) {
  let text = decodeXml(value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱]')
    .replace(/\b(?:\+?\d[\d ()-]{7,}\d)\b/g, '[电话]')
    .replace(/\b\d{16,19}\b/g, '[长数字]');
  return text.slice(0, Math.max(0, limit));
}

function bool(value, fallback = false) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return fallback;
}

function bounds(value) {
  const match = String(value || '').match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/);
  if (!match) return null;
  const [, x1, y1, x2, y2] = match.map(Number);
  if (![x1,y1,x2,y2].every(Number.isFinite) || x2 < x1 || y2 < y1) return null;
  return {x: x1, y: y1, width: x2 - x1, height: y2 - y1};
}

function attrs(raw = '') {
  const out = {};
  for (const match of String(raw).matchAll(/([\w:-]+)="([^"]*)"/g)) out[match[1]] = decodeXml(match[2]);
  return out;
}

export function treeHash(source) {
  return crypto.createHash('sha256').update(String(source || '')).digest('hex');
}

export function parseAndroidTree(source = '') {
  const xml = String(source || '');
  const hash = treeHash(xml);
  const elements = [];
  const stack = [];
  const tokens = xml.matchAll(/<\/?([\w.$:-]+)\b([^>]*)>/g);
  for (const token of tokens) {
    const full = token[0], tag = token[1], raw = token[2] || '';
    const closing = full.startsWith('</');
    const selfClosing = /\/\s*>$/.test(full);
    if (closing) { if (stack.length) stack.pop(); continue; }
    if (tag === 'hierarchy') { if (!selfClosing) stack.push(null); continue; }
    const a = attrs(raw);
    const b = bounds(a.bounds);
    const parentIndex = [...stack].reverse().find(item => Number.isInteger(item)) ?? null;
    const index = elements.length;
    const text = redactUiText(a.text || '');
    const contentDescription = redactUiText(a['content-desc'] || a.contentDescription || '');
    const resourceId = redactUiText(a['resource-id'] || a.resourceId || '', 180);
    const className = redactUiText(a.class || tag, 160);
    const visible = bool(a.displayed, b ? b.width > 0 && b.height > 0 : true);
    const element = {
      index,
      parentIndex,
      qaId: null,
      resourceId: resourceId || null,
      text: text || null,
      contentDescription: contentDescription || null,
      className: className || null,
      boundsPx: b,
      visible,
      clickable: bool(a.clickable),
      enabled: bool(a.enabled, true),
      focusable: bool(a.focusable),
      focused: bool(a.focused),
      scrollable: bool(a.scrollable),
      selected: bool(a.selected),
      packageName: redactUiText(a.package || '', 160) || null,
    };
    const useful = Boolean(element.resourceId || element.text || element.contentDescription || element.clickable || element.focusable || element.scrollable);
    element.useful = useful;
    elements.push(element);
    if (!selfClosing) stack.push(index);
  }
  const prefix = hash.slice(0, 16);
  for (const element of elements) element.elementRef = `el:${prefix}:${element.index}`;
  return {hash, elements, xml};
}

export function summarizeTree(parsed, options = {}) {
  const max = Math.max(1, Math.min(300, Number(options.maxElements) || MAX_SUMMARY_ELEMENTS));
  return parsed.elements.filter(element => element.useful && element.visible).slice(0, max).map(element => ({
    elementRef: element.elementRef, qaId: element.qaId, resourceId: element.resourceId, text: element.text,
    contentDescription: element.contentDescription, className: element.className, boundsPx: element.boundsPx,
    visible: element.visible, clickable: element.clickable, enabled: element.enabled, scrollable: element.scrollable,
  }));
}

export function parseElementRef(value) {
  const match = String(value || '').match(/^el:([a-f0-9]{16}):(\d{1,6})$/);
  return match ? {hashPrefix: match[1], index: Number(match[2])} : null;
}
