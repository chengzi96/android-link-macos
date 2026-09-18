import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {VERSION, redact} from './core.mjs';
import {ScrcpyVideoStream, ScrcpyControlStream, STREAM_MAGIC, eventToEnvelope, normalizeStreamFps, parseRefreshRate, parseDisplayModeRates, chooseDeviceRefreshRate, listH264Encoders, adaptiveStreamAttempts} from './video-stream.mjs';
import {MjpegVideoStream, normalizeMjpegFps} from './mjpeg-stream.mjs';
import {AndroidScreenRecorder} from './phone-recording.mjs';
import {detectAiIntegrations, connectAiClient, removeAiClient, testMcpHealth} from './ai-integration.mjs';

export function screenPoint(point, rect) {
  if (!point || ![point.x, point.y].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) ||
      !rect || ![rect.width, rect.height].every(v => Number.isFinite(v) && v > 0)) throw new Error('屏幕坐标无效，请刷新画面后重试。');
  return {x: Math.min(Math.floor(point.x * rect.width), rect.width - 1),
    y: Math.min(Math.floor(point.y * rect.height), rect.height - 1)};
}

export function preciseDragActions(fromPoint, toPoint, rect, requestedDurationMs = 280) {
  const from = screenPoint(fromPoint, rect), to = screenPoint(toPoint, rect);
  const requested = Number(requestedDurationMs);
  const duration = Math.max(180, Math.min(900, Number.isFinite(requested) ? Math.round(requested) : 280));
  return {from, to, duration, body: {actions: [{type: 'pointer', id: 'androidlink-finger', parameters: {pointerType: 'touch'}, actions: [
    {type: 'pointerMove', duration: 0, x: from.x, y: from.y, origin: 'viewport'},
    {type: 'pointerDown', button: 0},
    {type: 'pointerMove', duration, x: to.x, y: to.y, origin: 'viewport'},
    {type: 'pause', duration: 120},
    {type: 'pointerUp', button: 0},
  ]}]}};

}

export function quickSwipeActions(direction, rect, requestedDurationMs = 320) {
  const points = {
    up: [{x: .5, y: .75}, {x: .5, y: .25}],
    down: [{x: .5, y: .25}, {x: .5, y: .75}],
    left: [{x: .75, y: .5}, {x: .25, y: .5}],
    right: [{x: .25, y: .5}, {x: .75, y: .5}],
  };
  if (!points[direction]) throw new Error('滑动方向无效。');
  const [from, to] = points[direction];
  return preciseDragActions(from, to, rect, requestedDurationMs);
}

export function touchRetryDelay(failures, delays = [1500, 3000, 8000, 15000, 30000]) {
  const safe = Array.isArray(delays) && delays.length ? delays.map(value => Math.max(20, Number(value) || 20)) : [1500, 3000, 8000, 15000, 30000];
  const index = Math.max(0, Math.min(Number.isFinite(Number(failures)) ? Math.floor(Number(failures)) : 0, safe.length - 1));
  return safe[index];
}

function normalizePreviewSize(value) {return ['small', 'medium', 'large'].includes(value) ? value : 'medium';}

function decodeXML(value = '') {
  return value.replace(/&#(x?[0-9a-f]+);|&(amp|quot|apos|lt|gt);/gi, (match, numeric, named) => {
    if (numeric) {
      const code = Number.parseInt(numeric.replace(/^x/i, ''), /^x/i.test(numeric) ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    }
    return {amp: '&', quot: '"', apos: "'", lt: '<', gt: '>'}[named.toLowerCase()];
  });
}

function androidNodes(source) {
  const nodes = [];
  for (const tag of String(source).matchAll(/<([\w.$:-]+)\b([^>]*)>/g)) {
    const attributes = {};
    for (const attribute of tag[2].matchAll(/([\w:-]+)="([^"]*)"/g)) attributes[attribute[1]] = decodeXML(attribute[2]).trim();
    nodes.push({tag: tag[1], ...attributes});
  }
  return nodes;
}

function safeSemanticPart(value) {
  const raw = decodeXML(String(value || '')).trim();
  if (!raw || /https?:\/\/|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b(?:\+?\d[\d -]{6,}\d)\b|\b[\da-f]{24,}\b/i.test(raw)) return '';
  const clean = raw.replace(/[\\/:*?"<>|]/g, ' ').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, '')
    .replace(/[^\p{L}\p{N}._-]/gu, '').slice(0, 24);
  if (!clean || /^(?:android|view|textview|button|imageview|framelayout|linearlayout)$/i.test(clean) || /^\d{1,2}:\d{2}$/.test(clean) || /\d{5,}/.test(clean)) return '';
  return clean;
}

function appName(packageName) {
  const known = [
    [/^(?:com\.android\.settings|com\.miui\.settings|com\.coloros\.settings|com\.huawei\.systemmanager)$/, '设置'],
    [/^(?:com\.android\.launcher|com\.google\.android\.apps\.nexuslauncher|com\.miui\.home|com\.huawei\.android\.launcher|com\.oppo\.launcher|com\.vivo\.launcher)/, '主屏'],
    [/^com\.tencent\.mm$/, '微信'], [/^com\.android\.chrome$/, 'Chrome'], [/^com\.google\.android\.apps\.photos$/, '相册'],
    [/camera/i, '相机'], [/(?:dialer|contacts)/i, '电话'], [/(?:messaging|mms)/i, '短信'],
    [/(?:permissioncontroller|packageinstaller)/i, '权限确认'], [/systemui/i, '系统界面'],
  ];
  for (const [pattern, name] of known) if (pattern.test(packageName)) return name;
  return safeSemanticPart(packageName.split('.').slice(-2).join('.'));
}

export function semanticScreenshotLabel(source = '') {
  const nodes = androidNodes(source);
  const packages = [...new Set(nodes.map(node => node.package).filter(Boolean))];
  const foreground = packages.find(value => !/(?:systemui|inputmethod|keyboard)/i.test(value)) || packages[0] || '';
  const visible = nodes.flatMap(node => [node.text, node['content-desc']]).map(safeSemanticPart).filter(Boolean);
  const joined = visible.join(' ');
  const login = /登录|登陆|Sign\s?In|Log\s?In/i.test(joined) && /密码|验证码|手机号|邮箱|账号|Password|Verification\s?Code/i.test(joined);
  const register = /注册|Sign\s?Up|Create\sAccount/i.test(joined) && /密码|验证码|手机号|邮箱|账号|Password|Verification\s?Code/i.test(joined);
  const patterns = [/验证码.{0,5}(?:错误|无效|过期)/i, /(?:登录|登陆).{0,5}失败/i, /密码.{0,5}(?:错误|无效)/i,
    /(?:网络|连接|请求|加载|验证|操作).{0,5}(?:错误|失败|异常|超时)/i];
  let state = '';
  for (const pattern of patterns) {state = visible.find(value => pattern.test(value)) || '';if (state) break;}
  let base = login ? '登录页' : register ? '注册页' : '';
  const app = appName(foreground);
  const title = nodes.filter(node => /(?:title|toolbar|action_bar|header)/i.test(node['resource-id'] || ''))
    .flatMap(node => [safeSemanticPart(node.text), safeSemanticPart(node['content-desc'])]).find(Boolean) || '';
  if (!base) {
    if (app === '主屏') base = app;
    else if (app && title && app !== title) base = app + '_' + title;
    else base = title || app || visible.find(value => value.length >= 2) || 'Android页面';
  }
  return [base, state && state !== base ? state : ''].filter(Boolean).join('_').slice(0, 60) || 'Android页面';
}

function localStamp(date, withDashes = false) {
  const parts = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value, index) => String(value).padStart(index ? 2 : 4, '0'));
  return withDashes ? parts.slice(0, 3).join('-') + '_' + parts.slice(3).join('-') : parts.slice(0, 3).join('') + '-' + parts.slice(3).join('');
}

export function semanticScreenshotFilename(source, date = new Date(), sequence = 1) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime()) || !Number.isInteger(sequence) || sequence < 1) throw new Error('截图命名参数无效。');
  return `${localStamp(date)}_${semanticScreenshotLabel(source)}_${String(sequence).padStart(3, '0')}.png`;
}


function normalizedRect(rect) {
  if (!rect || ![rect.width, rect.height].every(value => Number.isFinite(value) && value > 0)) return null;
  return {x: Number.isFinite(rect.x) ? rect.x : 0, y: Number.isFinite(rect.y) ? rect.y : 0,
    width: Math.floor(rect.width), height: Math.floor(rect.height)};
}

export function pngDimensions(png) {
  if (!Buffer.isBuffer(png) || png.length < 24 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('未获得有效手机截图。');
  }
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  return width > 0 && height > 0 ? {width, height} : null;
}

export function videoSizeNeedsRectRefresh(previousVideoSize, nextVideoSize, rect) {
  if (!nextVideoSize || ![nextVideoSize.width, nextVideoSize.height].every(value => Number.isFinite(value) && value > 0)) return false;
  const nextLandscape = nextVideoSize.width > nextVideoSize.height;
  if (!rect || ![rect.width, rect.height].every(value => Number.isFinite(value) && value > 0)) return true;
  if ((rect.width > rect.height) !== nextLandscape) return true;
  if (!previousVideoSize) return false;
  return previousVideoSize.width !== nextVideoSize.width || previousVideoSize.height !== nextVideoSize.height;
}

const CONTROL_ASSET_FILES = ['control.html', 'control.js', 'control.css', 'refresh-scheduler.mjs', 'stream-client.mjs', 'stream-recovery.mjs', 'video-stream.mjs', 'mjpeg-stream.mjs'];

export function resolveControlAssetDirectory(candidates) {
  const defaults = [
    import.meta.dirname,
    path.join(os.homedir(), 'Applications', '安卓连接助手.app', 'Contents', 'Resources'),
    process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : null,
  ];
  const checked = [];
  for (const candidate of (candidates || defaults)) {
    if (!candidate) continue;
    const directory = path.resolve(candidate);
    if (checked.includes(directory)) continue;
    checked.push(directory);
    try {
      const info = fs.lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      const complete = CONTROL_ASSET_FILES.every(file => {
        const item = fs.lstatSync(path.join(directory, file));
        return item.isFile() && !item.isSymbolicLink();
      });
      if (complete) return directory;
    } catch {}
  }
  throw new Error('控制页资源不完整。请重新运行“安装安卓连接助手.command”覆盖安装后再试。');
}

export async function startControlServer(helper, options = {}) {
  const automation = options.automationService || null;
  const token = crypto.randomBytes(32).toString('hex');
  let origin, controlChain = Promise.resolve(), controlQueued = 0, lastError = '', screenshotDirectory = null, screenshotSequence = 0;
  let liveScreenshot = null, liveScreenshotAbort = null, liveStream = null, probeStream = null, touchStream = null, touchStreamPromise = null, touchRetryTimer = null, touchRetryAt = null, touchRetryFailures = 0, touchLastError = '', touchLastSuccessAt = null, cachedRect = normalizedRect(helper.screenRect), lastFrameSize = null, rectRefreshPending = false;
  let deviceRefreshHz = null, deviceRefreshChecked = false, h264Encoders = [], h264EncodersChecked = false, streamDiagnostic = {mode: 'idle', failures: []};
  let h264Diagnostic = {state: 'idle', failures: [], lastAttemptAt: null, lastSuccessAt: null, lastFailure: null};
  let connectionState = {phase: 'idle', deviceRef: null, message: ''};
  let lastDeviceDiscovery = {checkedAt: null, count: null, states: []};
  const touchRetryDelaysMs = Array.isArray(options.touchRetryDelaysMs) && options.touchRetryDelaysMs.length ? options.touchRetryDelaysMs.map(value => Math.max(20, Number(value) || 20)) : [1500, 3000, 8000, 15000, 30000];
  const touchStartTimeoutMs = Math.max(250, Number(options.touchStartTimeoutMs) || 3200);
  const recentScreenshots = [];
  const recentRecordings = [];
  const recorder = options.recorder || new AndroidScreenRecorder(helper, {localRoot: options.recordingRoot, maxDurationSeconds: options.recordingMaxDurationSeconds});
  const recordingSemanticSourceTimeoutMs = Math.max(300, Math.min(3000, Number(options.recordingSemanticSourceTimeoutMs) || 1500));
  let recordingFinalizePromise = null, recordingTimer = null, recordingSequence = 0, recordingLastError = '';
  const clearRecordingTimer = () => {if (recordingTimer) clearTimeout(recordingTimer);recordingTimer = null;};
  const sanitizeDiagnostic = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'string' ? item
    .replace(helper.device?.serial || /$^/, '[设备]').replace(/\/Users\/[^/\s"']+/g, '/Users/[用户]').slice(0, 600) : item));
  const diagnosticEvents = [];
  const pushDiagnosticEvent = (code, message, level = 'info', detail = null, coalesceMs = 800) => {
    const event = sanitizeDiagnostic({time: new Date().toISOString(), code: String(code || 'event').slice(0, 80), level,
      message: String(message || code || '事件').replace(/\s+/g, ' ').slice(0, 240), ...(detail ? {detail} : {})});
    const now = Date.now(), windowMs = Math.max(0, Number(coalesceMs) || 0);
    const duplicate = diagnosticEvents.slice(-20).reverse().find(item => item.code === event.code && item.message === event.message && now - Date.parse(item.time || 0) < windowMs);
    if (duplicate) {duplicate.repeatCount = Math.max(1, Number(duplicate.repeatCount) || 1) + 1;duplicate.lastSeenAt = event.time;return duplicate;}
    diagnosticEvents.push(event);diagnosticEvents.splice(0, Math.max(0, diagnosticEvents.length - 80));return event;
  };
  const updateDeviceDiscoveryDiagnostic = data => {
    const devices = Array.isArray(data?.devices) ? data.devices : [];
    const next = {checkedAt: new Date().toISOString(), count: devices.length, states: devices.map(item => item?.state || 'unknown').sort()};
    const before = `${lastDeviceDiscovery.count ?? 'x'}:${(lastDeviceDiscovery.states || []).join(',')}`;
    const after = `${next.count}:${next.states.join(',')}`;lastDeviceDiscovery = next;
    if (before !== after) pushDiagnosticEvent('adb-device-list-changed', devices.length ? `ADB 发现 ${devices.length} 台设备 · ${next.states.join(' / ')}` : 'ADB 当前未发现设备');
    return data;
  };
  const setStreamDiagnostic = value => {
    const previous = streamDiagnostic || {};streamDiagnostic = sanitizeDiagnostic(value);
    if (streamDiagnostic.mode !== previous.mode) {
      const mode = streamDiagnostic.mode || 'idle';
      pushDiagnosticEvent('stream-' + mode, `实时画面：${mode}`, /error|failed/.test(mode) ? 'error' : 'info');
    }
    if (helper.state && typeof helper.state === 'object') {helper.state.streamDiagnostic = streamDiagnostic;try {helper.save?.();} catch {}}
    return streamDiagnostic;
  };
  const setH264Diagnostic = value => {
    const previous = h264Diagnostic || {};h264Diagnostic = sanitizeDiagnostic({...h264Diagnostic, ...value});
    if (h264Diagnostic.state !== previous.state) {
      const state = h264Diagnostic.state || 'idle';pushDiagnosticEvent('h264-' + state, `H.264：${state}`, /failed|error/.test(state) ? 'error' : 'info');
    }
    if (helper.state && typeof helper.state === 'object') {helper.state.h264Diagnostic = h264Diagnostic;try {helper.save?.();} catch {}}
    return h264Diagnostic;
  };
  const deviceProfileKey = () => [helper.device?.manufacturer, helper.device?.brand, helper.device?.model, helper.device?.sdk]
    .map(value => String(value || '').replace(/[^\p{L}\p{N} ._()+-]/gu, '').trim().slice(0, 80)).join('|');
  const readDeviceProfile = () => helper.state?.streamProfiles?.[deviceProfileKey()] || null;
  const writeDeviceProfile = patch => {
    if (!helper.state || typeof helper.state !== 'object') return null;
    const key = deviceProfileKey();if (!key.replace(/\|/g, '')) return null;
    const previous = helper.state.streamProfiles?.[key] || {};
    helper.state.streamProfiles = {...(helper.state.streamProfiles || {}), [key]: {...previous, ...patch, updatedAt: new Date().toISOString()}};
    try {helper.save?.();} catch {}
    return helper.state.streamProfiles[key];
  };
  const rememberH264Success = profile => writeDeviceProfile({h264: {encoder: profile.encoder || 'default', fps: profile.fps, maxSize: profile.maxSize, bitRate: profile.bitRate, lastSuccessAt: new Date().toISOString()}});
  const rememberStreamFeedback = (mode, actualFps, targetFps) => {
    const actual = Number(actualFps), target = Number(targetFps);if (!['h264', 'mjpeg'].includes(mode) || !Number.isFinite(actual) || actual < 0 || actual > 240) return null;
    const current = readDeviceProfile()?.performance?.[mode] || {}, previous = Number(current.actualFps);
    const smoothed = Number.isFinite(previous) ? previous * .7 + actual * .3 : actual;
    const performance = {...(readDeviceProfile()?.performance || {}), [mode]: {actualFps: Number(smoothed.toFixed(1)), targetFps: Number.isFinite(target) ? target : null, observedAt: new Date().toISOString()}};
    return writeDeviceProfile({performance});
  };
  const screenshotRoot = options.screenshotRoot || path.join(os.homedir(), 'Pictures', 'AndroidLink截图');
  const liveScreenshotTimeoutMs = options.liveScreenshotTimeoutMs ?? 10000;
  const rectTimeoutMs = options.rectTimeoutMs ?? 8000;
  const files = {'/': ['control.html', 'text/html; charset=utf-8'], '/control.js': ['control.js', 'text/javascript; charset=utf-8'],
    '/control.css': ['control.css', 'text/css; charset=utf-8'], '/refresh-scheduler.mjs': ['refresh-scheduler.mjs', 'text/javascript; charset=utf-8'],
    '/stream-client.mjs': ['stream-client.mjs', 'text/javascript; charset=utf-8'], '/stream-recovery.mjs': ['stream-recovery.mjs', 'text/javascript; charset=utf-8'], '/mjpeg-stream.mjs': ['mjpeg-stream.mjs', 'text/javascript; charset=utf-8']};
  const assetDirectory = resolveControlAssetDirectory(options.assetDirectories);
  const assets = Object.fromEntries(Object.entries(files).map(([route, [file, type]]) =>
    [route, {body: fs.readFileSync(path.join(assetDirectory, file)), type}]));
  const json = (res, status, value) => {if (res.writableEnded) return;res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  const setRect = rect => {
    const next = normalizedRect(rect);
    if (!next) throw new Error('手机屏幕尺寸无效，请重新连接。');
    cachedRect = next; helper.screenRect = next; return next;
  };
  const call = async (route, method = 'GET', body, timeout = 45000, signal) => {
    if (!helper.session) throw new Error('手机已断开，请点“连接手机”。');
    try {return await helper.http(helper.base, '/session/' + encodeURIComponent(helper.session) + route, method, body, timeout, signal);}
    catch (error) {
      if (/invalid session id|session.*(?:terminated|not known)|NoSuchDriverError/i.test(error.message)) {
        await helper.disconnect();cachedRect = null;throw new Error('手机已断开，请点“连接手机”。');
      }
      throw error;
    }
  };
  const getRect = async (force = false, signal) => {
    if (!force && cachedRect) return cachedRect;
    return setRect(await call('/window/rect', 'GET', undefined, rectTimeoutMs, signal));
  };
  const observeVideoSize = size => {
    if (!size || ![size.width, size.height].every(value => Number.isFinite(value) && value > 0)) return;
    const previous = lastFrameSize;
    const needsRefresh = videoSizeNeedsRectRefresh(previous, size, cachedRect);
    lastFrameSize = {width: size.width, height: size.height};
    if (!needsRefresh || rectRefreshPending || !helper.session) return;
    rectRefreshPending = true;
    const operation = controlChain.then(() => getRect(true));
    controlChain = operation.catch(() => {});
    operation.catch(() => {}).finally(() => {rectRefreshPending = false;});
  };
  const validPNG = image => {
    const png = Buffer.from(image, 'base64'); pngDimensions(png); return png;
  };
  const screenshotFolder = date => {
    if (screenshotDirectory) return screenshotDirectory;
    fs.mkdirSync(screenshotRoot, {recursive: true, mode: 0o700});
    const rootInfo = fs.lstatSync(screenshotRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('截图目录不安全，未保存截图。');
    const base = localStamp(date, true) + '_截图';
    for (let suffix = 0; suffix < 100; suffix++) {
      const candidate = path.join(screenshotRoot, base + (suffix ? '_' + String(suffix + 1).padStart(2, '0') : ''));
      try {fs.mkdirSync(candidate, {mode: 0o700});screenshotDirectory = candidate;return candidate;}
      catch (error) {if (error.code !== 'EEXIST') throw error;}
    }
    throw new Error('无法创建新的截图目录。');
  };
  const recordingSnapshot = () => ({...recorder.status(), directory: fs.existsSync(recorder.localRoot) ? recorder.localRoot : null, items: recentRecordings, lastError: recordingLastError || recorder.status().lastError || ''});
  const finalizeRecording = async reason => {
    if (recordingFinalizePromise) return recordingFinalizePromise;
    clearRecordingTimer();
    recordingFinalizePromise = (async () => {
      let source = '';try {source = await call('/source', 'GET', undefined, recordingSemanticSourceTimeoutMs);} catch {}
      const stoppedAt = new Date();
      try {
        const item = await recorder.stop({label: semanticScreenshotLabel(source), date: stoppedAt, sequence: ++recordingSequence});
        const saved = {...item, reason: reason || 'manual'};recentRecordings.unshift(saved);recentRecordings.splice(10);recordingLastError = '';return saved;
      } catch (error) {
        recordingLastError = String(error?.message || error).replace(/\s+/g, ' ').slice(0, 500);throw error;
      }
    })().finally(() => {recordingFinalizePromise = null;});
    return recordingFinalizePromise;
  };
  const startRecording = async () => {
    if (!helper.session) throw new Error('手机已断开，无法开始录屏。');
    // Recording and H.264 background probing can compete for the phone video encoder.
    // Stop only the hidden probe; keep the current MJPEG/H.264 preview and control session untouched.
    if (probeStream) {await probeStream.stream.stop().catch(() => {});probeStream = null;}
    const started = await recorder.start();recordingLastError = '';clearRecordingTimer();
    recordingTimer = setTimeout(() => {finalizeRecording('system-time-limit').catch(() => {});}, Math.max(1000, started.maxDurationSeconds * 1000 + 1200));
    recordingTimer.unref?.();return started;
  };
  const execute = (script, args) => call('/execute/sync', 'POST', {script, args: [args]});
  const statusBarCommand = async action => {
    const command = {notifications: 'expand-notifications', quickSettings: 'expand-settings', collapse: 'collapse'}[action];
    if (!command) throw new Error('系统面板操作无效。');
    const serial = helper.device?.serial;
    if (!serial || typeof helper.adb !== 'function') throw new Error('当前没有可用的 Android ADB 连接。');
    await helper.adb(['-s', serial, 'shell', 'cmd', 'statusbar', command], {label: 'statusbar-' + action, timeout: 8000, sensitiveOutput: true});
    return {action};
  };
  const updateSettings = settings => call('/appium/settings', 'POST', {settings}, 12000);
  const detectDeviceRefresh = async force => {
    if (deviceRefreshChecked && !force) return deviceRefreshHz;
    deviceRefreshChecked = true; deviceRefreshHz = null;
    if (!helper.device?.serial) return null;
    const read = async args => {try {return await helper.adb(['-s', helper.device.serial, ...args], {label: 'display-refresh-rate', timeout: 8000, sensitiveOutput: true});} catch {return '';}};
    // Prefer the user's current refresh-rate choice, then the declared peak, then the active dumpsys display mode.
    // Do not take the largest number from dumpsys: some ROMs expose 240Hz touch-sampling/internal rates there.
    const user = parseRefreshRate(await read(['shell', 'settings', 'get', 'system', 'user_refresh_rate']));
    const peak = parseRefreshRate(await read(['shell', 'settings', 'get', 'system', 'peak_refresh_rate']));
    const displayDump = await read(['shell', 'dumpsys', 'display']);
    const active = parseRefreshRate(displayDump), modes = parseDisplayModeRates(displayDump);
    deviceRefreshHz = chooseDeviceRefreshRate(user, peak, active, modes);
    if (deviceRefreshHz) writeDeviceProfile({capabilities: {...(readDeviceProfile()?.capabilities || {}), refreshHz: deviceRefreshHz}});
    return deviceRefreshHz;
  };
  const detectH264Encoders = async force => {
    if (h264EncodersChecked && !force) return h264Encoders;
    h264EncodersChecked = true;h264Encoders = [];
    if (!helper.session || !helper.scrcpyServerPath) return h264Encoders;
    try {h264Encoders = await listH264Encoders(helper, {serverVersion: '4.1', timeoutMs: 9000});} catch {}
    writeDeviceProfile({capabilities: {...(readDeviceProfile()?.capabilities || {}), h264Encoders: h264Encoders.map(item => ({name: item.name, hardware: item.hardware, vendor: item.vendor})).slice(0, 16)}});
    return h264Encoders;
  };
  const clearTouchRetry = () => {if (touchRetryTimer) clearTimeout(touchRetryTimer);touchRetryTimer = null;touchRetryAt = null;};
  const touchControlState = () => {
    if (liveStream?.canControl?.()) return {mode: 'scrcpy-video', realtime: true, lastSuccessAt: touchLastSuccessAt, lastError: '', pipeline: liveStream?.diagnostic?.() || null};
    if (touchStream?.canControl?.()) return {mode: 'scrcpy-control-only', realtime: true, lastSuccessAt: touchLastSuccessAt, lastError: '', pipeline: touchStream?.diagnostic?.() || null};
    if (touchStreamPromise) return {mode: 'connecting', realtime: false, retryAt: touchRetryAt, lastError: touchLastError, pipeline: touchStream?.diagnostic?.() || null};
    return {mode: 'appium', realtime: false, retryAt: touchRetryAt, lastError: touchLastError, pipeline: touchStream?.diagnostic?.() || null};
  };
  const diagnosticSnapshot = () => {
    const connected = Boolean(helper.session), discovery = lastDeviceDiscovery || {}, touch = touchControlState();
    const observedState = discovery.states?.[0] || helper.state?.deviceObservation?.state || null;
    let usbValue = '未发现设备', usbKind = 'idle';
    if (connected) {usbValue = 'device / connected';usbKind = 'ok';}
    else if (connectionState.phase === 'connecting' || connectionState.phase === 'cancelling') {usbValue = connectionState.phase === 'connecting' ? 'connecting' : 'cancelling';usbKind = 'working';}
    else if ((discovery.count || 0) > 0) {usbValue = `${observedState || 'detected'} / ${discovery.count} 台`;usbKind = observedState === 'device' ? 'ok' : observedState === 'unauthorized' ? 'warn' : 'error';}
    else if (observedState && observedState !== 'device') {usbValue = observedState;usbKind = observedState === 'unauthorized' ? 'warn' : 'error';}
    const sessionValue = connected ? '正常' : connectionState.phase === 'connecting' ? '建立中' : '未建立';
    const sessionKind = connected ? 'ok' : connectionState.phase === 'connecting' ? 'working' : 'idle';
    const mode = String(streamDiagnostic?.mode || 'idle');
    let realtimeValue = '未启动', realtimeKind = connected ? 'working' : 'idle';
    if (/^scrcpy/.test(mode) || h264Diagnostic?.state === 'playing') {realtimeValue = /^scrcpy-(?:failed|error)/.test(mode) ? 'H.264 异常' : 'H.264';realtimeKind = /failed|error/.test(mode) ? 'error' : 'ok';}
    else if (/^mjpeg/.test(mode)) {realtimeValue = /failed|error/.test(mode) ? 'MJPEG 异常' : 'MJPEG';realtimeKind = /failed|error/.test(mode) ? 'error' : 'ok';}
    else if (connected) realtimeValue = h264Diagnostic?.state === 'probing' || h264Diagnostic?.state === 'starting' ? 'H.264 检测中' : '等待画面';
    const latest = diagnosticEvents.at(-1) || null;
    return sanitizeDiagnostic({version: VERSION, generatedAt: new Date().toISOString(), summary: {
      usbAdb: {value: usbValue, kind: usbKind}, session: {value: sessionValue, kind: sessionKind}, realtime: {value: realtimeValue, kind: realtimeKind,
        detail: {mode, h264State: h264Diagnostic?.state || 'idle', deviceRefreshHz, touchMode: touch.mode, directTouch: Boolean(touch.realtime)}},
      recentEvent: latest ? {value: latest.code, kind: latest.level === 'error' ? 'error' : 'ok', time: latest.time} : {value: 'control-server-ready', kind: 'ok'}},
      connectionState, recording: recordingSnapshot(), streamDiagnostic, h264Diagnostic, touchDiagnostic: touch,
      aiControl: automation?.leaseState?.() || {active: false}, deviceDiscovery: discovery, events: diagnosticEvents.slice(-20).reverse()});
  };
  const recentLogTails = () => {
    const root = helper.logDir;if (!root || !fs.existsSync(root)) return [];
    try {return fs.readdirSync(root).filter(name => name.endsWith('.log')).map(name => {
      const file = path.join(root, name), stat = fs.lstatSync(file);return stat.isFile() && !stat.isSymbolicLink() ? {name, file, mtimeMs: stat.mtimeMs} : null;
    }).filter(Boolean).sort((a,b) => b.mtimeMs - a.mtimeMs).slice(0, 8).map(item => {
      const text = fs.readFileSync(item.file, 'utf8').split(/\r?\n/).slice(-80).join('\n');
      return {name: item.name, tail: redact(text, helper.knownSecrets || []).slice(-24000)};
    });} catch {return [];}
  };
  const exportDiagnostic = async () => {
    try {updateDeviceDiscoveryDiagnostic(await helper.discoverDevices());} catch (error) {pushDiagnosticEvent('adb-diagnostic-refresh-failed', String(error?.message || error), 'error');}
    const desktop = path.join(os.homedir(), 'Desktop');fs.mkdirSync(desktop, {recursive: true});
    const stamp = new Date().toISOString().replace(/[:.]/g, '-'), fileName = `安卓连接诊断-${stamp}.txt`, destination = path.join(desktop, fileName);
    const payload = {tool: helper.diagnosticSummary?.() || {tool: VERSION, generatedAt: new Date().toISOString()}, liveMonitor: diagnosticSnapshot(),
      recentLogs: recentLogTails(), privacy: '已脱敏；不包含截图、页面结构、输入文字、控制页 Token 或 ADB 序列号。'};
    fs.writeFileSync(destination, redact(JSON.stringify(payload, null, 2), helper.knownSecrets || []) + '\n', {mode: 0o600, flag: 'wx'});
    pushDiagnosticEvent('diagnostic-exported', `诊断已导出：${fileName}`);
    await helper.command('/usr/bin/open', ['-R', destination], {label: 'reveal-control-diagnostic', timeout: 10000}).catch(() => {});
    return {ok: true, fileName};
  };
  const stopTouchStream = async (resetRetry = true) => {
    if (resetRetry) {clearTouchRetry();touchRetryFailures = 0;touchLastError = '';}
    const pending = touchStreamPromise;touchStreamPromise = null;
    if (pending) pending.catch(() => {});
    if (!touchStream) return;const current = touchStream;touchStream = null;await current.stop().catch(() => {});
  };
  const shouldRetryTouch = () => Boolean(helper.session && /^(?:scrcpy|mjpeg)/.test(String(streamDiagnostic?.mode || '')) && !liveStream?.canControl?.() && !touchStream?.canControl?.());
  const scheduleTouchRetry = delay => {
    clearTouchRetry();if (!shouldRetryTouch()) return;
    const wait = Math.max(20, Number(delay) || touchRetryDelay(touchRetryFailures, touchRetryDelaysMs));
    touchRetryAt = new Date(Date.now() + wait).toISOString();
    touchRetryTimer = setTimeout(() => {touchRetryTimer = null;touchRetryAt = null;ensureTouchStream(true).catch(() => {});}, wait);
  };
  const ensureTouchStream = async force => {
    if (liveStream?.canControl?.()) {clearTouchRetry();return liveStream;}
    if (touchStream?.canControl?.()) {clearTouchRetry();return touchStream;}
    if (touchStreamPromise) return touchStreamPromise;
    if (!helper.session || !helper.scrcpyServerPath || !helper.adbPath) return null;
    if (!force && touchRetryTimer) return null;
    const candidate = new ScrcpyControlStream(helper, {onError: error => {
      if (touchStream === candidate) touchStream = null;candidate.stop().catch(() => {});
      touchLastError = String(error?.message || error).replace(/\s+/g, ' ').slice(0, 240);touchRetryFailures = Math.min(touchRetryFailures + 1, 20);
      setStreamDiagnostic({...streamDiagnostic, touchControl: 'appium-fallback', touchControlError: touchLastError});
      pushDiagnosticEvent('touch-appium-fallback', `跟手触控回退 Appium · ${touchLastError}`, 'error', candidate.diagnostic?.() || null, 15000);scheduleTouchRetry();
    }});
    touchStreamPromise = (async () => {
      try {
        await candidate.start(touchStartTimeoutMs);touchStream = candidate;touchRetryFailures = 0;touchLastError = '';touchLastSuccessAt = new Date().toISOString();clearTouchRetry();
        setStreamDiagnostic({...streamDiagnostic, touchControl: 'scrcpy-control-only', touchControlError: null});
        pushDiagnosticEvent('touch-scrcpy-ready', '跟手触控：scrcpy-control-only 已稳定连接', 'info', candidate.diagnostic?.() || null, 5000);return candidate;
      } catch (error) {
        await candidate.stop().catch(() => {});touchLastError = String(error?.message || error).replace(/\s+/g, ' ').slice(0, 240);touchRetryFailures = Math.min(touchRetryFailures + 1, 20);
        setStreamDiagnostic({...streamDiagnostic, touchControl: 'appium-fallback', touchControlError: touchLastError});
        pushDiagnosticEvent('touch-appium-fallback', `跟手触控回退 Appium · ${touchLastError}`, 'error', candidate.diagnostic?.() || null, 15000);scheduleTouchRetry();return null;
      } finally {touchStreamPromise = null;}
    })();
    return touchStreamPromise;
  };
  automation?.setHooks?.({beforeDisconnect: async () => {
    if (recorder.active) await finalizeRecording('ai-disconnect').catch(() => {});
    if (probeStream) {await probeStream.stream.stop().catch(() => {});probeStream = null;}
    if (liveStream) {await liveStream.stop().catch(() => {});liveStream = null;}
    await stopTouchStream();touchLastSuccessAt = null;cachedRect = null;lastFrameSize = null;deviceRefreshChecked = false;deviceRefreshHz = null;h264EncodersChecked = false;h264Encoders = [];
    setStreamDiagnostic({mode: 'idle', failures: []});setH264Diagnostic({state: 'idle', failures: [], lastAttemptAt: null, lastSuccessAt: null, lastFailure: null});helper.screenRect = null;
  }});
  const cancelLiveScreenshot = () => {if (liveScreenshotAbort && !liveScreenshotAbort.signal.aborted) liveScreenshotAbort.abort('superseded-by-control');};
  const captureLive = async signal => {
    const image = await call('/screenshot', 'GET', undefined, liveScreenshotTimeoutMs, signal);
    const png = validPNG(image), size = pngDimensions(png), sizeChanged = lastFrameSize && size &&
      (size.width !== lastFrameSize.width || size.height !== lastFrameSize.height);
    if (!cachedRect) await getRect(true, signal);
    else if (sizeChanged) {
      try {await getRect(true, signal);} catch (error) {
        if (signal?.aborted) throw error;
        setRect({x: 0, y: 0, width: size.width, height: size.height});
      }
    }
    lastFrameSize = size;
    return {png, rect: cachedRect || {x: 0, y: 0, ...size}, capturedAt: new Date().toISOString()};
  };
  async function dispatch(route, body) {
    if (route === '/api/status') {
      if (helper.session && !deviceRefreshChecked) detectDeviceRefresh(false).catch(() => {});
      const remembered = readDeviceProfile();
      return {version: VERSION, connected: Boolean(helper.session), os: helper.session ? (helper.device?.os || '') : '',
        model: helper.session ? (helper.device?.model || 'Android') : '', connectedAt: helper.connectedAt || null, inspectorURL: helper.session && helper.base ? helper.base + '/inspector' : null,
        currentDeviceRef: helper.session && helper.device?.serial ? helper.deviceRef?.(helper.device.serial) || null : null,
        autoConnect: Boolean(helper.state?.uiPreferences?.autoConnect), connectionState,
        realtimeAvailable: Boolean(helper.scrcpyServerPath && fs.existsSync(helper.scrcpyServerPath)), mjpegAvailable: Boolean(helper.session),
        deviceRefreshHz, directTouchAvailable: Boolean(liveStream?.canControl?.() || touchStream?.canControl?.()), touchControl: touchControlState(),
        deviceProfile: remembered ? {h264: remembered.h264 || null, performance: remembered.performance || null, encoderCount: h264Encoders.length} : {encoderCount: h264Encoders.length},
        previewSize: normalizePreviewSize(helper.state?.uiPreferences?.previewSize), recording: recordingSnapshot(), streamDiagnostic, h264Diagnostic,
        aiControl: automation?.leaseState?.() || {active: false}, error: lastError};
    }
    if (route === '/api/ai-integrations') return detectAiIntegrations();
    if (route === '/api/ai-connect') {
      const client = typeof body.client === 'string' ? body.client : '';
      const result = connectAiClient(client);pushDiagnosticEvent('ai-integration-connected', `${client || 'AI'} MCP 接入配置已更新`);return {...result, integrations: detectAiIntegrations()};
    }
    if (route === '/api/ai-remove') {
      const client = typeof body.client === 'string' ? body.client : '';
      const result = removeAiClient(client);pushDiagnosticEvent('ai-integration-removed', `${client || 'AI'} MCP 接入配置已移除`);return {...result, integrations: detectAiIntegrations()};
    }
    if (route === '/api/mcp-test') {
      const result = await testMcpHealth(helper.root || path.join(os.homedir(), 'Library', 'Application Support', 'AndroidLink'));
      pushDiagnosticEvent('mcp-self-test-ok', `MCP 自检正常 · ${result.toolCount} 个工具`);return result;
    }
    if (route === '/api/diagnostics') return diagnosticSnapshot();
    if (route === '/api/export-diagnostic') return exportDiagnostic();
    if (route === '/api/screenshots') return {directory: screenshotDirectory, items: recentScreenshots};
    if (route === '/api/recording') return recordingSnapshot();
    if (route === '/api/devices') return updateDeviceDiscoveryDiagnostic(await helper.discoverDevices());
    if (route === '/api/takeover') return {ok: true, ...(automation?.humanTakeover?.() || {active: false})};
    if (route === '/api/quit') {setTimeout(() => {try {process.kill(process.pid, 'SIGTERM');} catch {}}, 250);return {ok: true, quitting: true};}
    if (route === '/api/connect') {
      if (recorder.active) await finalizeRecording('reconnect').catch(() => {});
      if (probeStream) {await probeStream.stream.stop().catch(() => {});probeStream = null;}
      if (liveStream) {await liveStream.stop();liveStream = null;}await stopTouchStream();
      connectionState = {phase: 'connecting', deviceRef: typeof body.deviceRef === 'string' ? body.deviceRef : null, message: '正在建立手机控制会话…'};pushDiagnosticEvent('connect-started', '正在建立 Android 控制会话');
      try {
        const selected = body.deviceRef ? await helper.connectDeviceRef(body.deviceRef) : (await helper.reconnect(), {ref: helper.deviceRef?.(helper.device?.serial) || null, model: helper.device?.model || 'Android', os: helper.device?.os || ''});
        cachedRect = normalizedRect(helper.screenRect);lastFrameSize = null;deviceRefreshChecked = false;deviceRefreshHz = null;h264EncodersChecked = false;h264Encoders = [];touchLastSuccessAt = null;setStreamDiagnostic({mode: 'idle', failures: []});setH264Diagnostic({state: 'idle', failures: [], lastAttemptAt: null, lastSuccessAt: null, lastFailure: null});
        if (!cachedRect) await getRect(true);Promise.allSettled([detectDeviceRefresh(true), detectH264Encoders(true)]);lastError = '';connectionState = {phase: 'idle', deviceRef: selected.ref || null, message: ''};pushDiagnosticEvent('session-ready', `控制 Session 已建立 · ${helper.device?.model || 'Android'}`);return {connected: true, device: selected};
      } catch (error) {connectionState = {phase: /取消/.test(error?.message || '') ? 'cancelled' : 'error', deviceRef: null, message: String(error?.message || error).slice(0,240)};pushDiagnosticEvent(connectionState.phase === 'cancelled' ? 'connect-cancelled' : 'connect-failed', connectionState.message || '连接失败', connectionState.phase === 'cancelled' ? 'info' : 'error');throw error;}
    }
    if (route === '/api/cancel-connect') {
      connectionState = {phase: 'cancelling', deviceRef: connectionState.deviceRef || null, message: '正在取消连接…'};
      await helper.cancelConnection();cachedRect = null;lastFrameSize = null;deviceRefreshChecked = false;deviceRefreshHz = null;h264EncodersChecked = false;h264Encoders = [];touchLastSuccessAt = null;
      connectionState = {phase: 'idle', deviceRef: null, message: ''};return {connected: false, cancelled: true};
    }
    if (route === '/api/disconnect') {pushDiagnosticEvent('disconnect-started', '正在断开 Android 控制会话');if (recorder.active) await finalizeRecording('disconnect').catch(() => {});if (probeStream) {await probeStream.stream.stop().catch(() => {});probeStream = null;}if (liveStream) {await liveStream.stop();liveStream = null;}await stopTouchStream();touchLastSuccessAt = null;await helper.disconnect();cachedRect = null;lastFrameSize = null;deviceRefreshChecked = false;deviceRefreshHz = null;h264EncodersChecked = false;h264Encoders = [];setStreamDiagnostic({mode: 'idle', failures: []});setH264Diagnostic({state: 'idle', failures: [], lastAttemptAt: null, lastSuccessAt: null, lastFailure: null});helper.screenRect = null;pushDiagnosticEvent('session-disconnected', '控制 Session 已断开');return {connected: false};}
    if (route === '/api/source') return {source: await call('/source', 'GET', undefined, 12000)};
    if (route === '/api/save-screenshot') {
      const captured = new Date(), image = await call('/screenshot', 'GET', undefined, 30000), png = validPNG(image);
      let source = '';try {source = await call('/source', 'GET', undefined, 15000);} catch {}
      const directory = screenshotFolder(captured);let fileName;
      for (;;) {
        fileName = semanticScreenshotFilename(source, captured, ++screenshotSequence);
        try {fs.writeFileSync(path.join(directory, fileName), png, {flag: 'wx', mode: 0o600});break;}
        catch (error) {if (error.code !== 'EEXIST') throw error;}
      }
      const item = {fileName, savedAt: captured.toISOString(), semanticName: semanticScreenshotLabel(source)};
      recentScreenshots.unshift(item);recentScreenshots.splice(10);return {...item, directory};
    }
    if (route === '/api/open-screenshot-folder') {
      if (!screenshotDirectory || !fs.existsSync(screenshotDirectory)) throw new Error('还没有保存截图。');
      await helper.command('/usr/bin/open', [screenshotDirectory], {label: 'open-screenshot-folder', timeout: 10000});return {opened: true};
    }
    if (route === '/api/start-recording') {
      const result = await startRecording();return {ok: true, ...result, recording: recordingSnapshot()};
    }
    if (route === '/api/stop-recording') {
      const item = await finalizeRecording('manual');return {ok: true, ...item, recording: recordingSnapshot()};
    }
    if (route === '/api/open-recording-folder') {
      if (!fs.existsSync(recorder.localRoot)) throw new Error('还没有保存录屏。');
      const info = fs.lstatSync(recorder.localRoot);if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('录屏目录不安全，未打开。');
      await helper.command('/usr/bin/open', [recorder.localRoot], {label: 'open-recording-folder', timeout: 10000});return {opened: true};
    }
    if (route === '/api/promote-stream') {
      const streamId = typeof body.streamId === 'string' ? body.streamId : '';
      if (!probeStream || !streamId || probeStream.id !== streamId) throw new Error('H.264 后台探测流已失效，请稍后自动重试。');
      const promoted = probeStream;probeStream = null;const previous = liveStream;liveStream = promoted.stream;promoted.promoted = true;
      if (previous && previous !== promoted.stream) await previous.stop().catch(() => {});rememberH264Success(promoted.profile);
      const promotedTouch = touchControlState();
      setH264Diagnostic({state: 'playing', lastSuccessAt: new Date().toISOString(), lastFailure: null, profile: promoted.profile,
        failures: promoted.failures || [], pipeline: promoted.stream.diagnostic?.() || null, touchControl: promotedTouch.mode});
      setStreamDiagnostic({mode: 'scrcpy', requestedFps: promoted.requestedFps, actualTargetFps: promoted.profile.fps, deviceRefreshHz, profile: promoted.profile,
        touchControl: promotedTouch.realtime ? promotedTouch.mode : 'connecting', failures: promoted.failures || [], recoveredFrom: 'mjpeg-background-probe', pipeline: promoted.stream.diagnostic?.() || null});lastError = '';
      ensureTouchStream(true).catch(() => {});
      return {ok: true, mode: 'h264', streamId, targetFps: promoted.profile.fps, directTouch: Boolean(promotedTouch.realtime)};
    }
    if (route === '/api/video-size') {
      const width = Math.floor(Number(body.width)), height = Math.floor(Number(body.height));
      if (![width, height].every(value => Number.isFinite(value) && value > 0 && value <= 16384)) throw new Error('实时画面尺寸无效。');
      observeVideoSize({width, height});return {ok: true};
    }
    if (route === '/api/stream-feedback') {
      rememberStreamFeedback(String(body.mode || ''), body.actualFps, body.targetFps);return {ok: true};
    }
    if (route === '/api/ui-preference') {
      const patch = {};
      if (Object.prototype.hasOwnProperty.call(body, 'previewSize')) {const previewSize = normalizePreviewSize(body.previewSize);if (previewSize !== body.previewSize) throw new Error('显示尺寸无效。');patch.previewSize = previewSize;}
      if (Object.prototype.hasOwnProperty.call(body, 'autoConnect')) {if (typeof body.autoConnect !== 'boolean') throw new Error('自动连接设置无效。');patch.autoConnect = body.autoConnect;}
      if (!Object.keys(patch).length) throw new Error('没有可保存的界面设置。');
      if (helper.state && typeof helper.state === 'object') {helper.state.uiPreferences = {...(helper.state.uiPreferences || {}), ...patch};try {helper.save?.();} catch {}}
      return {...patch};
    }
    if (automation && ['/api/home','/api/back','/api/recent','/api/notifications','/api/quick-settings','/api/collapse-panel','/api/tap','/api/swipe','/api/drag','/api/input'].includes(route)) {
      const method = route.slice('/api/'.length);
      await automation.humanAction(method, body);
    } else if (route === '/api/home') await execute('mobile: pressKey', {keycode: 3});
    else if (route === '/api/back') await execute('mobile: pressKey', {keycode: 4});
    else if (route === '/api/recent') await execute('mobile: pressKey', {keycode: 187});
    else if (route === '/api/notifications') await statusBarCommand('notifications');
    else if (route === '/api/quick-settings') await statusBarCommand('quickSettings');
    else if (route === '/api/collapse-panel') await statusBarCommand('collapse');
    else if (route === '/api/tap') await execute('mobile: clickGesture', screenPoint(body, await getRect()));
    else if (route === '/api/swipe') {
      const rect = await getRect(), gesture = quickSwipeActions(body.direction, rect);
      try {await call('/actions', 'POST', gesture.body, 12000);}
      finally {await call('/actions', 'DELETE', undefined, 5000).catch(() => {});}
    } else if (route === '/api/drag') {
      const rect = await getRect(), gesture = preciseDragActions(body.from, body.to, rect, body.durationMs);
      try {await call('/actions', 'POST', gesture.body, 12000);}
      finally {await call('/actions', 'DELETE', undefined, 5000).catch(() => {});}
    } else if (route === '/api/input') {
      if (typeof body.text !== 'string' || !body.text || body.text.length > 2000) throw new Error('请输入 1–2000 个字符。');
      if (helper.knownSecrets && !helper.knownSecrets.includes(body.text)) helper.knownSecrets.push(body.text);
      const element = await call('/element/active');
      const id = element?.['element-6066-11e4-a52e-4f735466cecf'] || element?.ELEMENT;
      if (typeof id !== 'string' || !id) throw new Error('请先在手机画面中点击输入框。');
      await call('/element/' + encodeURIComponent(id) + '/value', 'POST', {text: body.text});
    } else throw new Error('不支持的控制操作。');
    lastError = '';return {ok: true};
  }
  const queuedRoutes = new Set(['/api/connect', '/api/disconnect', '/api/source', '/api/save-screenshot', '/api/open-screenshot-folder',
    '/api/home', '/api/back', '/api/recent', '/api/notifications', '/api/quick-settings', '/api/collapse-panel', '/api/tap', '/api/swipe', '/api/drag', '/api/input']);
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');res.setHeader('X-Content-Type-Options', 'nosniff');res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) {json(res, 403, {error: '拒绝来自其他网页的控制请求。'});return;}
    const requestURL = new URL(req.url, origin);
    const route = requestURL.pathname;
    if (assets[route] && req.method === 'GET') {res.writeHead(200, {'Content-Type': assets[route].type});res.end(assets[route].body);return;}
    const supplied = String(req.headers['x-androidlink-token'] || '');
    if (!/^[a-f0-9]{64}$/.test(supplied) || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {json(res, 403, {error: '请从连接助手重新打开控制页。'});return;}
    const getRoutes = ['/api/status', '/api/ai-integrations', '/api/diagnostics', '/api/devices', '/api/stream', '/api/mjpeg', '/api/screenshot', '/api/source', '/api/screenshots', '/api/recording'];
    const postRoutes = ['/api/connect', '/api/cancel-connect', '/api/disconnect', '/api/quit', '/api/home', '/api/back', '/api/recent', '/api/notifications', '/api/quick-settings', '/api/collapse-panel', '/api/tap', '/api/swipe', '/api/drag', '/api/input',
      '/api/save-screenshot', '/api/open-screenshot-folder', '/api/takeover', '/api/start-recording', '/api/stop-recording', '/api/open-recording-folder', '/api/touch', '/api/promote-stream', '/api/video-size', '/api/stream-feedback', '/api/ui-preference', '/api/export-diagnostic', '/api/ai-connect', '/api/ai-remove', '/api/mcp-test'];
    if (!(req.method === 'GET' && getRoutes.includes(route)) && !(req.method === 'POST' && postRoutes.includes(route))) {json(res, 404, {error: '不支持的控制请求。'});return;}

    if (route === '/api/touch' && req.method === 'POST') {
      try {
        automation?.lease?.assertHumanCanWrite?.();
        const chunks = [];let size = 0;
        for await (const chunk of req) {size += chunk.length;if (size > 2048) {json(res, 413, {error: '触摸参数过长。'});return;}chunks.push(chunk);}
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!['down', 'move', 'up', 'cancel'].includes(body.action)) {json(res, 400, {error: '触摸动作无效。'});return;}
        let controller = liveStream?.canControl?.() ? liveStream : touchStream?.canControl?.() ? touchStream : null;
        if (!controller && liveStream) controller = await ensureTouchStream(true);
        if (!controller?.canControl?.()) {json(res, 409, {error: touchLastError ? '实时跟手触控暂不可用：' + touchLastError : '实时跟手触控正在恢复，请稍后再试。'});return;}
        const touchSize = lastFrameSize && lastFrameSize.width && lastFrameSize.height ? lastFrameSize : await getRect();const point = screenPoint(body, touchSize);
        const action = body.action === 'cancel' ? 'up' : body.action;
        await controller.injectTouch(action, point, touchSize);
        json(res, 200, {ok: true, direct: true, channel: controller === touchStream ? 'scrcpy-control-only' : 'scrcpy-video'});return;
      } catch (error) {json(res, error?.code === 'LEASE_CONFLICT' ? 409 : 400, {error: String(error?.message || '直连触控失败。').slice(0, 240)});return;}
    }

    if (route === '/api/stream' && req.method === 'GET') {
      if (!helper.session) {json(res, 409, {error: '手机已断开。'});return;}
      const isProbe = requestURL.searchParams.get('probe') === '1';
      if (isProbe && ['recording', 'stopping'].includes(recorder.status().phase)) {json(res, 409, {error: '手机原生录屏进行中，H.264 后台探测已暂停；录屏结束后会自动恢复。'});return;}
      if (isProbe ? Boolean(probeStream) : Boolean(liveStream)) {json(res, 429, {error: isProbe ? '已有 H.264 后台探测正在运行。' : '已有实时视频流正在运行。'});return;}
      const requestedFps = normalizeStreamFps(requestURL.searchParams.get('fps'));
      const [refreshHz, encoders] = await Promise.all([detectDeviceRefresh(false).catch(() => null), detectH264Encoders(false).catch(() => [])]);
      const remembered = readDeviceProfile()?.h264 || null;
      const attempts = adaptiveStreamAttempts(requestedFps, refreshHz, encoders, remembered);
      const failures = [];let selected = null, selectedStream = null, bufferedEvents = [], responseStarted = false, closed = false;
      const attemptAt = new Date().toISOString();
      setH264Diagnostic({state: isProbe ? 'probing' : 'starting', requestedFps, deviceRefreshHz: refreshHz, failures: [], lastAttemptAt: attemptAt});
      const makeScrcpyStream = () => new ScrcpyVideoStream(helper, {controlEnabled: false,
        onEvent: event => {
          if (event.type === 'resize') observeVideoSize({width: event.width, height: event.height});
          if (!responseStarted) {if (bufferedEvents.length < 16) bufferedEvents.push(event);return;}
          if (!closed && !res.writableEnded) res.write(eventToEnvelope(event));
        },
        onError: error => {
          if (!responseStarted) return;
          const pipeline = selectedStream?.diagnostic?.() || null;
          const runtimeError = 'H.264 实时视频流中断：' + String(error?.message || error).replace(/\s+/g, ' ').slice(0, 420);
          setH264Diagnostic({state: 'runtime-error', lastFailure: runtimeError, runtimeError, pipeline});
          if (!isProbe) {lastError = runtimeError;setStreamDiagnostic({...streamDiagnostic, mode: 'scrcpy-error', runtimeError: lastError, pipeline});}
          if (!res.writableEnded) res.end();
        },
      });
      for (const profile of attempts) {
        if (res.writableEnded || res.destroyed) return;
        const stream = makeScrcpyStream();
        try {
          await stream.startProfile(profile);
          selected = profile;selectedStream = stream;break;
        } catch (error) {
          const pipeline = stream.diagnostic?.() || null;
          const message = String(error?.message || error).replace(/\s+/g, ' ').slice(0, 500);
          failures.push({fps: profile.fps, maxSize: profile.maxSize, encoder: profile.encoder || 'default',
            stage: error?.stage || pipeline?.stage || 'unknown', reason: message, pipeline});
          await stream.stop().catch(() => {});bufferedEvents = [];
        }
      }
      if (!selectedStream) {
        const lastFailure = failures.at(-1)?.reason || '未获得有效 H.264 视频头。';
        setH264Diagnostic({state: 'failed', requestedFps, deviceRefreshHz: refreshHz, failures, lastFailure, lastAttemptAt: attemptAt,
          pipeline: failures.at(-1)?.pipeline || null});
        if (!isProbe) setStreamDiagnostic({mode: 'scrcpy-failed', requestedFps, deviceRefreshHz: refreshHz, failures, pipeline: failures.at(-1)?.pipeline || null});
        const failureMessage = 'H.264 实时流启动失败；将尝试 MJPEG。' + (lastFailure ? ' ' + lastFailure : '');
        if (!isProbe) lastError = failureMessage;
        json(res, 503, {error: failureMessage, mode: 'scrcpy', probe: isProbe, requestedFps, deviceRefreshHz: refreshHz, failures});return;
      }
      const streamId = crypto.randomBytes(12).toString('hex');
      if (isProbe) probeStream = {id: streamId, stream: selectedStream, profile: selected, requestedFps, failures, promoted: false};
      else {liveStream = selectedStream;rememberH264Success(selected);}
      responseStarted = true;
      const videoPipeline = selectedStream.diagnostic?.() || null;
      const currentTouch = touchControlState();
      setH264Diagnostic({state: isProbe ? 'probe-streaming' : 'playing', requestedFps, actualTargetFps: selected.fps, deviceRefreshHz: refreshHz,
        profile: selected, touchControl: currentTouch.mode, failures, pipeline: videoPipeline, lastAttemptAt: attemptAt,
        ...(isProbe ? {} : {lastSuccessAt: new Date().toISOString(), lastFailure: null})});
      if (!isProbe) {setStreamDiagnostic({mode: 'scrcpy', requestedFps, actualTargetFps: selected.fps, deviceRefreshHz: refreshHz, profile: selected,
        touchControl: currentTouch.realtime ? currentTouch.mode : 'connecting', failures, pipeline: videoPipeline});lastError = '';ensureTouchStream(true).catch(() => {});}
      res.writeHead(200, {'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked',
        'X-AndroidLink-Video': 'scrcpy-h264', 'X-AndroidLink-Target-Fps': String(selected.fps), 'X-AndroidLink-Stream-Id': streamId,
        'X-AndroidLink-Probe': isProbe ? '1' : '0', 'X-AndroidLink-Device-Hz': refreshHz ? String(refreshHz) : 'unknown',
        'X-AndroidLink-Encoder': selected.encoder || 'default', 'X-AndroidLink-Touch': touchControlState().realtime ? 'scrcpy' : 'connecting'});
      res.write(STREAM_MAGIC);for (const event of bufferedEvents) res.write(eventToEnvelope(event));bufferedEvents = [];
      const cleanup = async () => {
        if (closed) return;closed = true;
        if (probeStream?.id === streamId) probeStream = null;
        if (liveStream === selectedStream) liveStream = null;
        await selectedStream.stop();
      };
      req.once('aborted', cleanup);res.once('close', cleanup);
      return;
    }

    if (route === '/api/mjpeg' && req.method === 'GET') {
      if (!helper.session) {json(res, 409, {error: '手机已断开。'});return;}
      if (liveStream) {json(res, 429, {error: '已有实时视频流正在运行。'});return;}
      const refreshHz = await detectDeviceRefresh(false).catch(() => null);
      const requested = normalizeMjpegFps(Math.min(Number(requestURL.searchParams.get('fps')) || 30, refreshHz || 60));
      const observedFps = Number(readDeviceProfile()?.performance?.mjpeg?.actualFps);
      const stream = new MjpegVideoStream(helper, {updateSettings});let closed = false;
      try {
        const {profile, response: upstream} = await stream.start(requested, 4500, Number.isFinite(observedFps) ? observedFps : null);
        liveStream = stream;const controller = touchStream?.canControl?.() ? touchStream : null;
        setStreamDiagnostic({mode: 'mjpeg', deviceRefreshHz: refreshHz, profile, adaptiveFromObservedFps: Number.isFinite(observedFps) ? observedFps : null, touchControl: controller?.canControl?.() ? 'scrcpy-control-only' : 'connecting'});lastError = '';
        ensureTouchStream(true).catch(() => {});
        res.writeHead(200, {'Content-Type': upstream.headers['content-type'] || 'multipart/x-mixed-replace; boundary=--BoundaryString',
          'Transfer-Encoding': 'chunked', 'X-AndroidLink-Video': 'uiautomator2-mjpeg', 'X-AndroidLink-Target-Fps': String(profile.fps),
          'X-AndroidLink-Touch': controller?.canControl?.() ? 'scrcpy' : 'connecting'});
        const cleanup = async () => {if (closed) return;closed = true;if (liveStream === stream) liveStream = null;await stream.stop();};
        upstream.on('data', chunk => {if (!closed && !res.writableEnded) res.write(chunk);});
        upstream.once('end', () => {if (!res.writableEnded) res.end();cleanup();});
        upstream.once('error', error => {lastError = 'MJPEG 实时流中断：' + String(error?.message || error).slice(0, 240);setStreamDiagnostic({...streamDiagnostic, mode: 'mjpeg-error', runtimeError: lastError});if (!res.writableEnded) res.end();cleanup();});
        req.once('aborted', cleanup);res.once('close', cleanup);return;
      } catch (error) {
        await stream.stop().catch(() => {});
        const reason = String(error?.message || error).replace(/\s+/g, ' ').slice(0, 500);
        setStreamDiagnostic({mode: 'mjpeg-failed', deviceRefreshHz: refreshHz, failure: reason});lastError = 'MJPEG 实时流启动失败：' + reason;
        json(res, 503, {error: lastError, mode: 'mjpeg', deviceRefreshHz: refreshHz});return;
      }
    }

    if (route === '/api/screenshot' && req.method === 'GET') {
      if (liveScreenshot) {json(res, 429, {error: '上一帧仍在获取，本次刷新已丢弃。'});return;}
      const controller = new AbortController();liveScreenshotAbort = controller;
      res.once('close', () => {if (!res.writableEnded && !controller.signal.aborted) controller.abort('client-closed');});
      const operation = captureLive(controller.signal);liveScreenshot = operation;
      try {
        const frame = await operation;
        if (controller.signal.aborted || res.writableEnded) return;
        res.writeHead(200, {'Content-Type': 'image/png', 'Content-Length': String(frame.png.length),
          'X-AndroidLink-Captured-At': frame.capturedAt, 'X-AndroidLink-Width': String(frame.rect.width), 'X-AndroidLink-Height': String(frame.rect.height)});
        res.end(frame.png);
      } catch (error) {
        if (controller.signal.aborted) {json(res, 409, {error: '实时画面已被新的手机操作替代。'});}
        else if (error?.name === 'TimeoutError' || /timeout|timed out|超时/i.test(error?.message || '')) {json(res, 408, {error: '实时画面获取超时，下一轮会自动重试。'});}
        else {lastError = /手机已断开|截图/.test(error.message) ? error.message : '实时画面刷新失败，下一轮会自动重试。';json(res, 400, {error: lastError});}
      } finally {
        if (liveScreenshot === operation) liveScreenshot = null;
        if (liveScreenshotAbort === controller) liveScreenshotAbort = null;
      }
      return;
    }

    try {
      const humanWriteRoutes = new Set(['/api/connect','/api/cancel-connect','/api/disconnect','/api/home','/api/back','/api/recent','/api/notifications','/api/quick-settings','/api/collapse-panel','/api/tap','/api/swipe','/api/drag','/api/input','/api/start-recording','/api/stop-recording']);
      if (humanWriteRoutes.has(route)) automation?.lease?.assertHumanCanWrite?.();
      const chunks = [];let size = 0;
      for await (const chunk of req) {size += chunk.length;if (size > 16384) {json(res, 413, {error: '输入内容过长。'});return;}chunks.push(chunk);}
      const data = Buffer.concat(chunks).toString('utf8'), body = data ? JSON.parse(data) : {};
      if (!body || typeof body !== 'object' || Array.isArray(body)) {json(res, 400, {error: '控制参数无效。'});return;}
      let operation;
      if (queuedRoutes.has(route)) {
        cancelLiveScreenshot();
        if (controlQueued >= 8) {json(res, 429, {error: '手机操作过于密集，请稍候。'});return;}
        controlQueued++;operation = controlChain.then(() => dispatch(route, body));controlChain = operation.catch(() => {});
      } else operation = dispatch(route, body);
      try {json(res, 200, await operation);}
      catch (error) {lastError = error?.code === 'LEASE_CONFLICT' || /手机已断开|Android 手机当前未连接|设备引用|连接已取消|USB|调试|授权|ADB|离线|屏幕坐标|方向无效|请输入|截图|请先在手机画面|还没有保存|屏幕尺寸|H\.264|探测流|显示尺寸|录屏|回传|screenrecord|MediaCodec|encoder|编码器|视频编码|录制|AI 正在控制|租约|控制者/i.test(error.message) ? error.message :
        '操作未完成，请确认手机已解锁；若连接已中断，请点“重新连接”。';pushDiagnosticEvent('api-error', `${route.replace('/api/','')} · ${lastError}`, 'error');json(res, error?.code === 'LEASE_CONFLICT' ? 409 : 400, {error: lastError});}
      finally {if (queuedRoutes.has(route)) controlQueued--;}
    } catch (error) {if (error?.code === 'LEASE_CONFLICT') json(res, 409, {error: String(error.message).slice(0,240)}); else json(res, 400, {error: '控制参数无法读取。'});}
  });
  server.requestTimeout = 30000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      // Publish the exact localhost origin before the listen promise resolves, so no request handler can observe an uninitialized origin.
      origin = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
  pushDiagnosticEvent('control-server-ready', '控制服务已就绪');
  return {url: origin + '/#' + token, origin, close: async () => {clearRecordingTimer();if (recorder.active) await finalizeRecording('server-close').catch(() => recorder.stopWithoutPull().catch(() => {}));cancelLiveScreenshot();if (probeStream) {await probeStream.stream.stop().catch(() => {});probeStream = null;}if (liveStream) {await liveStream.stop();liveStream = null;}await stopTouchStream();server.closeAllConnections();await new Promise(resolve => server.close(resolve));}};
}
