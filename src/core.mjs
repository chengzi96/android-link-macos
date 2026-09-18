import fs from 'node:fs';
import path from 'node:path';

export const VERSION = '0.5.6';
export const HOST_COMPAT = Object.freeze({minMacOSMajor: 12, nodeVersion: '22.16.0', architectures: Object.freeze(['arm64', 'x64'])});
export const PACKAGES = Object.freeze({appium: '3.7.0', uiautomator2: '8.6.1', inspector: '2026.7.1', mcpServer: '2.0.0'});
export const SCRCPY_SERVER = Object.freeze({
  version: '4.1',
  url: 'https://github.com/Genymobile/scrcpy/releases/download/v4.1/scrcpy-server-v4.1',
  sha256: 'deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae',
  size: 733706,
});
export const PLATFORM_TOOLS = Object.freeze({
  version: '37.0.1',
  url: 'https://dl.google.com/android/repository/platform-tools_r37.0.1-darwin.zip',
  sha256: 'ee39ad5967e95c2a07f04dbcbde96b1a0c916ba376096db5d2f498b7727a5d1d',
});
export const JDK = Object.freeze({
  version: '17.0.20.1+1',
  arm64: Object.freeze({
    url: 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_aarch64_mac_hotspot_17.0.20.1_1.tar.gz',
    sha256: '196d13ba5f10414bef7f6a05a9b3f00edacb18ebacef2b99485db9e2ee18f0e8',
  }),
  x64: Object.freeze({
    url: 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_x64_mac_hotspot_17.0.20.1_1.tar.gz',
    sha256: 'c01975da12ed4235250ff891fe8bba73a9e73037d444b269c9d0922b5dbc8e0a',
  }),
});

export function versionTuple(value) {
  const match = String(value).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) throw new Error('无法解析版本：' + value);
  return [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
}

export function compatibleNode(version) {
  const [major, minor] = versionTuple(version);
  return (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major >= 24;
}

export function compatibleMacOS(version) {
  try { const [major] = versionTuple(version); return major >= HOST_COMPAT.minMacOSMajor; }
  catch { return false; }
}

export function compatibleJavaOutput(value) {
  return /(?:^|\n)(?:openjdk|java)(?:\s+version)?\s+"?17(?:[.\s"])/im.test(String(value));
}

export function validSerial(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

export function parseAdbDevices(raw) {
  const devices = [];
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.trim() || /^List of devices attached/.test(line) || /^\*/.test(line)) continue;
    const match = line.match(/^(\S+)\s+(device|unauthorized|offline|no permissions)(?:\s+(.*))?$/);
    if (!match || !validSerial(match[1])) continue;
    const fields = {};
    for (const item of String(match[3] || '').matchAll(/(?:^|\s)(product|model|device|transport_id):([^\s]+)/g)) fields[item[1]] = item[2];
    devices.push({serial: match[1], state: match[2] === 'no permissions' ? 'no-permissions' : match[2],
      model: String(fields.model || fields.device || 'Android').replaceAll('_', ' '),
      product: fields.product || '', device: fields.device || '', transportId: fields.transport_id || ''});
  }
  return devices;
}

export function normalizeProperties(record, values = {}) {
  if (!record || !validSerial(record.serial)) throw new Error('ADB 设备标识无效。');
  const sdk = Number.parseInt(values.sdk, 10);
  const safe = value => String(value || '').replace(/[^\p{L}\p{N} ._()+-]/gu, '').trim().slice(0, 80);
  return {
    serial: record.serial,
    state: ['device', 'unauthorized', 'offline', 'no-permissions'].includes(record.state) ? record.state : 'unknown',
    sdk: Number.isInteger(sdk) && sdk >= 1 && sdk <= 1000 ? sdk : null,
    os: /^\d+(?:\.\d+){0,3}$/.test(String(values.os || '')) ? String(values.os) : '',
    manufacturer: safe(values.manufacturer), brand: safe(values.brand),
    model: safe(values.model) || safe(record.model) || 'Android',
  };
}

export function deviceProblems(device) {
  const errors = [];
  if (!device || !validSerial(device.serial)) errors.push('没有取得有效的 Android 设备标识。');
  if (device?.state === 'unauthorized') errors.push('手机尚未允许这台电脑进行 USB 调试。请解锁手机，在系统弹窗中核对并允许此电脑。');
  else if (device?.state === 'offline') errors.push('ADB 已看到手机但设备离线。请重新插线、解锁，并重新确认 USB 调试。');
  else if (device?.state === 'no-permissions') errors.push('当前账户没有访问 Android USB 设备的权限。');
  else if (device?.state !== 'device') errors.push('Android 手机当前不可操作，请连接数据线并开启 USB 调试。');
  if (!Number.isInteger(device?.sdk)) errors.push('未读取到 Android API 版本。');
  else if (device.sdk < 26) errors.push('当前驱动支持 Android 8 / API 26 及以上；这台设备版本过旧。');
  return errors;
}

export function deviceDiagnostic(device) {
  return device ? {state: device.state, sdk: device.sdk, os: device.os || '未识别',
    manufacturer: device.manufacturer || '未识别', brand: device.brand || '未识别', model: device.model || '未识别'} : null;
}

export function capabilities(device) {
  if (deviceProblems(device).length) throw new Error('设备参数未通过检查。');
  const xiaomiFamily = /(?:xiaomi|redmi|poco)/i.test([device.manufacturer, device.brand].join(' '));
  return {platformName: 'Android', 'appium:automationName': 'UiAutomator2', 'appium:udid': device.serial,
    'appium:deviceName': device.model, ...(device.os ? {'appium:platformVersion': device.os} : {}),
    'appium:noReset': true, 'appium:fullReset': false, 'appium:autoGrantPermissions': false,
    'appium:disableWindowAnimation': false, 'appium:skipUnlock': true,
    ...(xiaomiFamily ? {'appium:ignoreHiddenApiPolicyError': true} : {}),
    'appium:adbExecTimeout': 30000, 'appium:uiautomator2ServerInstallTimeout': 120000,
    'appium:uiautomator2ServerLaunchTimeout': 120000, 'appium:newCommandTimeout': 3600};
}

export function assertAppiumResponse(json, status) {
  if (!json || typeof json !== 'object') throw new Error('Appium 返回了无法识别的内容。');
  if (status < 200 || status >= 300 || json.value?.error) throw new Error(json.value?.message || json.message || 'Appium 请求失败。');
  return json.value;
}

export function errorCategory(raw) {
  const text = String(raw);
  if (/device unauthorized|unauthorized|allow usb debugging/i.test(text)) return 'usb-authorization';
  if (/device offline|offline/i.test(text)) return 'device-offline';
  if (/no devices?\/emulators? found|device ['"]?[^\s'"]+['"]? not found|unknown device/i.test(text)) return 'no-device';
  if (/API level.*(?:lower|minimum)|Android 8|sdk version.*(?:old|unsupported)/i.test(text)) return 'unsupported-android';
  if (/JAVA_HOME|java(?: executable)? (?:not found|cannot)|Unable to locate a Java Runtime|UnsupportedClassVersionError/i.test(text)) return 'java';
  if (/INSTALL_FAILED_USER_RESTRICTED|install canceled by user|USB installation|USB debugging.*security/i.test(text)) return 'install-restricted';
  if (/Hidden API policy.*cannot be enabled|WRITE_SECURE_SETTINGS/i.test(text)) return 'hidden-api-policy';
  if (/UiAutomator2|instrumentation.*failed|socket hang up/i.test(text)) return 'uiautomator2';
  if (/EAI_AGAIN|ENOTFOUND|ECONNRESET|CERT_|proxy|unable to get local issuer|403|407/i.test(text)) return 'network';
  if (/EACCES|EPERM|permission denied|not permitted/i.test(text)) return 'permission';
  if (/EADDRINUSE/i.test(text)) return 'port';
  if (/timeout|timed out|超时/i.test(text)) return 'timeout';
  return 'unknown';
}

export function errorHint(raw) {
  switch (errorCategory(raw)) {
    case 'usb-authorization': return '请解锁 Android 手机，在“允许 USB 调试”弹窗核对并允许这台电脑；助手会在重新打开后继续。';
    case 'device-offline': return '手机处于 ADB 离线状态。请重新插线、解锁，并撤销后重新允许 USB 调试授权。';
    case 'no-device': return '没有发现当前可用的 Android 手机。请使用数据线连接，并把 USB 用途保持为数据传输或默认模式。';
    case 'unsupported-android': return '当前版本支持 Android 8 / API 26 及以上。';
    case 'java': return '专用 Java 运行环境未就绪；请重新运行安装器，助手不会修改系统 Java。';
    case 'install-restricted': return '手机阻止了自动化组件安装。部分品牌需在开发者选项额外开启“USB 调试（安全设置）”或“通过 USB 安装”。';
    case 'hidden-api-policy': return '手机系统拒绝修改 Hidden API Policy。助手只会对已识别的小米/Redmi/POCO 设备使用 UiAutomator2 兼容模式。';
    case 'uiautomator2': return '手机自动化组件未能启动。请保持解锁；助手重连时只处理本工具的 UiAutomator2 组件。';
    case 'network': return '固定依赖下载失败。请检查网络或代理；助手不会关闭 TLS 或切换未知镜像。';
    case 'permission': return '本机文件或 USB 权限不足，请使用当前普通账户运行，不要使用 sudo。';
    case 'port': return '本机端口被占用；助手不会终止不属于自己的服务。';
    case 'timeout': return '步骤超时并已停止自己的子进程。请保持手机解锁后重试。';
    default: return '尚不能确定根因，请导出脱敏诊断。';
  }
}

export function errorEvidence(raw) {
  const lines = String(raw).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const important = lines.filter(line => /error|failed|unauthorized|offline|INSTALL_|UiAutomator|instrumentation|JAVA_HOME|NoSuchDriver|timeout/i.test(line));
  return (important.length ? important : lines).slice(-4).map(line => line.slice(0, 500));
}

export function redact(input, secrets = []) {
  let text = String(input).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  for (const value of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(value).join('[已脱敏]');
  return text.replace(/\/Users\/[^/\s"']+/g, '/Users/[用户]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱]')
    .replace(/((?:password|passwd|token|authorization|_authToken)\s*[:=]\s*)[^\s,]+/gi, '$1[已脱敏]')
    .replace(/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/g, '$1[凭据]@');
}

export function safeChild(root, target) {
  const base = path.resolve(root), candidate = path.resolve(target);
  if (candidate === base || !candidate.startsWith(base + path.sep)) throw new Error('路径不在工具专用目录内。');
  return candidate;
}

export function readJson(file, fallback = null) {
  try {return JSON.parse(fs.readFileSync(file, 'utf8'));}
  catch (error) {if (error.code === 'ENOENT') return fallback;throw new Error('状态文件无法读取：' + error.message);}
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const temporary = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(temporary, file);
}
