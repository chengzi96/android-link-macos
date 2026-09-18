export const ERROR_CODES = Object.freeze([
  'ASSISTANT_NOT_RUNNING','PROTOCOL_VERSION_UNSUPPORTED','AUTH_FAILED','DEVICE_NOT_CONNECTED','DEVICE_LOCKED','SESSION_NOT_READY',
  'LEASE_REQUIRED','LEASE_CONFLICT','LEASE_EXPIRED','INVALID_SELECTOR','ELEMENT_NOT_FOUND','AMBIGUOUS_ELEMENT','STALE_ELEMENT',
  'ACTION_TIMEOUT','WAIT_TIMEOUT','APP_NOT_INSTALLED','RUNTIME_SPEC_UNAVAILABLE','HUMAN_ACTION_REQUIRED','RATE_LIMITED','INTERNAL_ERROR',
]);

const MESSAGES = Object.freeze({
  ASSISTANT_NOT_RUNNING: '安卓连接助手尚未运行，请先启动并连接手机。',
  PROTOCOL_VERSION_UNSUPPORTED: '工具协议版本不受支持。',
  AUTH_FAILED: '本机工具认证失败，请重新启动安卓连接助手。',
  DEVICE_NOT_CONNECTED: '当前没有已连接的 Android 手机。',
  DEVICE_LOCKED: '手机当前处于锁定或不可交互状态。',
  SESSION_NOT_READY: 'Android 自动化会话尚未就绪。',
  LEASE_REQUIRED: '此操作需要有效的 AI 控制租约。',
  LEASE_CONFLICT: '当前已有其他控制者持有手机控制权。',
  LEASE_EXPIRED: 'AI 控制租约已过期，请重新获取。',
  INVALID_SELECTOR: '元素选择器无效。',
  ELEMENT_NOT_FOUND: '没有找到符合条件的元素。',
  AMBIGUOUS_ELEMENT: '找到多个符合条件的元素，请增加限定条件或明确 index。',
  STALE_ELEMENT: '元素引用所属页面已经变化，请重新观察页面。',
  ACTION_TIMEOUT: '手机操作超时。',
  WAIT_TIMEOUT: '等待条件超时。',
  APP_NOT_INSTALLED: '目标应用未安装。',
  RUNTIME_SPEC_UNAVAILABLE: '当前没有可用的 RuntimeSpec Provider。',
  HUMAN_ACTION_REQUIRED: '需要人工在手机或控制页面完成此步骤。',
  RATE_LIMITED: '请求过于频繁，请稍后重试。',
  INTERNAL_ERROR: '本机工具层发生内部错误。',
});

export class AutomationError extends Error {
  constructor(code, message, options = {}) {
    super(message || MESSAGES[code] || MESSAGES.INTERNAL_ERROR);
    this.name = 'AutomationError';
    this.code = ERROR_CODES.includes(code) ? code : 'INTERNAL_ERROR';
    this.retryable = Boolean(options.retryable);
    this.details = options.details && typeof options.details === 'object' ? options.details : {};
    if (options.cause) this.cause = options.cause;
  }
}

export function asAutomationError(error, fallbackCode = 'INTERNAL_ERROR') {
  if (error instanceof AutomationError) return error;
  const message = String(error?.message || error || MESSAGES[fallbackCode]).replace(/\s+/g, ' ').slice(0, 400);
  if (/invalid session id|NoSuchDriver|手机已断开|not connected/i.test(message)) return new AutomationError('DEVICE_NOT_CONNECTED', undefined, {retryable: true});
  if (/timeout|timed out|超时/i.test(message)) return new AutomationError(fallbackCode === 'WAIT_TIMEOUT' ? 'WAIT_TIMEOUT' : 'ACTION_TIMEOUT', undefined, {retryable: true});
  return new AutomationError(fallbackCode, message || undefined, {retryable: false});
}

export function publicError(error) {
  const value = asAutomationError(error);
  return {code: value.code, message: value.message, retryable: value.retryable, details: sanitizeDetails(value.details)};
}

function sanitizeDetails(details) {
  if (!details || typeof details !== 'object') return {};
  const safe = {};
  for (const [key, value] of Object.entries(details)) {
    if (/serial|secret|token|password|text|xml|source|home|user/i.test(key)) continue;
    if (value == null || typeof value === 'boolean' || typeof value === 'number') safe[key] = value;
    else if (typeof value === 'string') safe[key] = value.replace(/\/Users\/[^/\s"']+/g, '/Users/[用户]').slice(0, 240);
    else if (Array.isArray(value)) safe[key] = value.slice(0, 20).map(item => typeof item === 'string' ? item.slice(0, 120) : item);
  }
  return safe;
}
