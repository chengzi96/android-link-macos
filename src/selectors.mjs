import {AutomationError} from './automation-errors.mjs';
import {parseElementRef} from './ui-tree.mjs';

const ALLOWED_KEYS = new Set(['elementRef','qaId','resourceId','text','contentDescription','className','clickable','visible','enabled','within','index']);

function normalizeTextMatcher(value) {
  if (typeof value === 'string') return {equals: value};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = ['equals','contains','startsWith','endsWith'];
  const present = keys.filter(key => typeof value[key] === 'string');
  if (present.length !== 1) return null;
  const key = present[0];
  if (!value[key] || value[key].length > 200) return null;
  return {[key]: value[key]};
}

export function normalizeSelector(input, depth = 0) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || depth > 4) throw new AutomationError('INVALID_SELECTOR');
  for (const key of Object.keys(input)) if (!ALLOWED_KEYS.has(key)) throw new AutomationError('INVALID_SELECTOR', `不支持的 Selector 字段：${key}`);
  const out = {};
  if (input.elementRef != null) {
    if (!parseElementRef(input.elementRef)) throw new AutomationError('INVALID_SELECTOR', 'elementRef 格式无效。');
    out.elementRef = input.elementRef;
  }
  for (const key of ['qaId','resourceId','className']) {
    if (input[key] != null) {
      if (typeof input[key] !== 'string' || !input[key] || input[key].length > 220) throw new AutomationError('INVALID_SELECTOR');
      out[key] = input[key];
    }
  }
  for (const key of ['text','contentDescription']) {
    if (input[key] != null) {
      const matcher = normalizeTextMatcher(input[key]);
      if (!matcher) throw new AutomationError('INVALID_SELECTOR', `${key} 匹配条件无效。`);
      out[key] = matcher;
    }
  }
  for (const key of ['clickable','visible','enabled']) if (input[key] != null) {
    if (typeof input[key] !== 'boolean') throw new AutomationError('INVALID_SELECTOR');
    out[key] = input[key];
  }
  if (input.index != null) {
    if (!Number.isInteger(input.index) || input.index < 0 || input.index > 1000) throw new AutomationError('INVALID_SELECTOR', 'index 必须是非负整数。');
    out.index = input.index;
  }
  if (input.within != null) out.within = normalizeSelector(input.within, depth + 1);
  if (!Object.keys(out).length) throw new AutomationError('INVALID_SELECTOR', 'Selector 不能为空。');
  return out;
}

function matchesText(actual, matcher) {
  const text = String(actual || '');
  if (matcher.equals != null) return text === matcher.equals;
  if (matcher.contains != null) return text.includes(matcher.contains);
  if (matcher.startsWith != null) return text.startsWith(matcher.startsWith);
  if (matcher.endsWith != null) return text.endsWith(matcher.endsWith);
  return false;
}

function basicMatch(element, selector) {
  if (selector.elementRef && element.elementRef !== selector.elementRef) return false;
  for (const key of ['qaId','resourceId','className']) if (selector[key] != null && element[key] !== selector[key]) return false;
  if (selector.text && !matchesText(element.text, selector.text)) return false;
  if (selector.contentDescription && !matchesText(element.contentDescription, selector.contentDescription)) return false;
  for (const key of ['clickable','visible','enabled']) if (selector[key] != null && Boolean(element[key]) !== selector[key]) return false;
  return true;
}

function selectorMatches(elements, selector) {
  let parents = null;
  if (selector.within) parents = new Set(selectorMatches(elements, selector.within).map(element => element.index));
  let matches = elements.filter(element => {
    if (!basicMatch(element, selector)) return false;
    if (!parents) return true;
    let parent = element.parentIndex;
    while (Number.isInteger(parent) && elements[parent]) {
      if (parents.has(parent)) return true;
      parent = elements[parent].parentIndex;
    }
    return false;
  });
  if (selector.index != null) matches = matches[selector.index] ? [matches[selector.index]] : [];
  return matches;
}

export function findElements(parsed, rawSelector) {
  const selector = normalizeSelector(rawSelector);
  const checkRefs = current => {
    if (current.elementRef) {
      const ref = parseElementRef(current.elementRef);
      if (ref.hashPrefix !== parsed.hash.slice(0, 16)) throw new AutomationError('STALE_ELEMENT');
    }
    if (current.within) checkRefs(current.within);
  };
  checkRefs(selector);
  return selectorMatches(parsed.elements, selector);
}

export function uniqueElement(parsed, selector) {
  const matches = findElements(parsed, selector);
  if (!matches.length) throw new AutomationError('ELEMENT_NOT_FOUND');
  if (matches.length > 1) throw new AutomationError('AMBIGUOUS_ELEMENT', undefined, {details: {count: matches.length}});
  return matches[0];
}
