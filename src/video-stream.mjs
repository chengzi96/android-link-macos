import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';

export const STREAM_MAGIC = Buffer.from('ALV1');
export const STREAM_EVENT = Object.freeze({CONFIG: 1, KEY: 2, DELTA: 3, RESIZE: 4});
const CONFIG_FLAG = 1n << 62n;
const KEY_FLAG = 1n << 61n;
const PTS_MASK = KEY_FLAG - 1n;

export function normalizeStreamFps(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 60;
  if (n >= 105) return 120;
  if (n >= 75) return 90;
  if (n >= 50) return 60;
  if (n >= 38) return 45;
  return 30;
}

export function parseRefreshRate(raw) {
  const text = String(raw || ''), plain = text.trim();
  const valid = value => {const n = Number(value);return Number.isFinite(n) && n >= 24 && n <= 240 ? n : null;};
  // settings get system peak_refresh_rate/user_refresh_rate returns a plain value. Treat it as authoritative.
  if (/^\d+(?:\.\d+)?$/.test(plain)) return valid(plain);
  // dumpsys display contains many unrelated rates (touch sampling, supported modes, render history).
  // Prefer the active/current display mode instead of taking the largest number on the page.
  const priority = [
    /(?:mActiveMode|activeMode|activeDisplayMode)[^\n]{0,180}?(?:refreshRate|fps)\s*[=:]?\s*(\d+(?:\.\d+)?)/i,
    /(?:renderFrameRate|currentRefreshRate|activeRefreshRate|mRefreshRate)\s*[=:]?\s*(\d+(?:\.\d+)?)/i,
    /(?:DisplayMode|Mode)[^\n]{0,120}?\b(?:fps|refreshRate)\s*[=:]?\s*(\d+(?:\.\d+)?)/i,
  ];
  for (const pattern of priority) {const match = text.match(pattern), n = match ? valid(match[1]) : null;if (n) return n;}
  // Conservative fallback: accept an explicit refresh-rate label, but never generic "fps" values.
  const labelled = [...text.matchAll(/(?:peak_refresh_rate|user_refresh_rate|refreshRate|refresh rate)\s*[:=]?\s*(\d+(?:\.\d+)?)/gi)]
    .map(match => valid(match[1])).filter(Boolean);
  return labelled.length ? labelled[0] : null;
}

export function parseDisplayModeRates(raw) {
  const text = String(raw || ''), values = [];
  const add = value => {const n = Number(value);if (Number.isFinite(n) && n >= 24 && n <= 240 && !values.some(item => Math.abs(item - n) < .2)) values.push(n);};
  for (const line of text.split(/\r?\n/)) {
    // Only collect values that are explicitly attached to a display-mode description.
    // Generic renderer/game fps values and touch-sampling rates must never raise the panel ceiling.
    if (!/(?:supportedModes?|DisplayMode|activeMode|modeId|display mode)/i.test(line)) continue;
    for (const match of line.matchAll(/(?:fps|refreshRate)\s*[=:]?\s*(\d+(?:\.\d+)?)/gi)) add(match[1]);
  }
  return values.sort((a, b) => a - b);
}


export function chooseDeviceRefreshRate(userRate, peakRate, activeRate, supportedRates = []) {
  const valid = value => {const n = Number(value);return Number.isFinite(n) && n >= 24 && n <= 240 ? n : null;};
  const user = valid(userRate), peak = valid(peakRate), active = valid(activeRate);
  const supported = (Array.isArray(supportedRates) ? supportedRates : []).map(valid).filter(Boolean);
  const maxMode = supported.length ? Math.max(...supported) : null;
  const declared = user || peak || null;
  // If dumpsys exposes supported display modes, never let an unrelated 240Hz touch-sampling value override them.
  // Without a supported-mode list, tolerate a configured high-refresh mode up to 2× the current active rate.
  const declaredLooksValid = declared && (maxMode ? declared <= maxMode + 1 : (!active || declared <= active * 2.05));
  return declaredLooksValid ? declared : active || maxMode || declared || null;
}

export function parseH264Encoders(raw) {
  const result = [], seen = new Set();
  for (const line of String(raw || '').split(/\r?\n/)) {
    if (!/video-codec=h264/i.test(line)) continue;
    const match = line.match(/video-encoder=(?:'([^']+)'|\"([^\"]+)\"|([^\s]+))/i);
    const name = (match?.[1] || match?.[2] || match?.[3] || '').trim().replace(/\((?:hw|sw)\)$/i, '');
    if (!name || name.length > 180 || seen.has(name)) continue;
    seen.add(name);
    const software = /\(sw\)|google|android\.(?:avc|h264)\.encoder/i.test(line + ' ' + name);
    const hardware = /\(hw\)|\[vendor\]|qcom|qti|exynos|mtk|mediatek|kirin|hisi|amlogic|nvidia/i.test(line + ' ' + name) && !software;
    result.push({name, hardware, software, vendor: /\[vendor\]|qcom|qti|exynos|mtk|mediatek|kirin|hisi|amlogic|nvidia/i.test(line + ' ' + name)});
  }
  return result;
}

export function rankH264Encoders(encoders = [], preferred = '') {
  const items = Array.isArray(encoders) ? encoders.filter(item => item && typeof item.name === 'string') : [];
  return [...items].sort((a, b) => {
    const score = item => (item.name === preferred ? 100 : 0) + (item.hardware ? 30 : 0) + (item.vendor ? 10 : 0) - (item.software ? 40 : 0);
    return score(b) - score(a) || a.name.localeCompare(b.name);
  });
}

export function streamProfile(fps) {
  const target = normalizeStreamFps(fps);
  if (target >= 120) return {fps: 120, maxSize: 1280, bitRate: 7_000_000};
  if (target >= 90) return {fps: 90, maxSize: 1440, bitRate: 7_000_000};
  if (target >= 60) return {fps: 60, maxSize: 1600, bitRate: 8_000_000};
  if (target >= 45) return {fps: 45, maxSize: 1440, bitRate: 6_000_000};
  return {fps: 30, maxSize: 1280, bitRate: 4_000_000};
}

export function streamProfileLadder(requestedFps, deviceRefreshHz = null) {
  const requested = normalizeStreamFps(requestedFps);
  const cap = Number.isFinite(Number(deviceRefreshHz)) ? Number(deviceRefreshHz) : requested;
  const ceiling = Math.min(requested, cap >= 105 ? 120 : cap >= 75 ? 90 : cap >= 50 ? 60 : cap >= 38 ? 45 : 30);
  const order = [120, 90, 60, 45, 30].filter(fps => fps <= ceiling);
  if (!order.length) order.push(30);
  return order.map(streamProfile);
}

export function adaptiveStreamAttempts(requestedFps, deviceRefreshHz = null, encoders = [], remembered = null) {
  const ladder = streamProfileLadder(requestedFps, deviceRefreshHz);
  const preferred = typeof remembered?.encoder === 'string' && remembered.encoder !== 'default' ? remembered.encoder : '';
  const ranked = rankH264Encoders(encoders, preferred).filter(item => !item.software);
  const hardware = ranked.map(item => item.name).filter(Boolean);
  const attempts = [], seen = new Set();
  const add = (profile, encoder) => {
    if (!profile || attempts.length >= 8) return;
    const key = `${profile.fps}|${profile.maxSize}|${encoder || 'default'}`;
    if (seen.has(key)) return;
    seen.add(key);attempts.push({...profile, encoder: encoder || null});
  };

  // Reuse a known-good combination first, then probe only a small set of high-value alternatives.
  // This keeps an incompatible phone from spending tens of seconds walking a full fps × encoder matrix before MJPEG fallback.
  if (remembered && Number.isFinite(Number(remembered.fps))) {
    const nearest = ladder.find(item => item.fps <= Number(remembered.fps)) || ladder.at(-1);
    add(nearest, preferred || null);
  }
  const top = ladder[0], low = ladder.at(-1), middle = ladder[Math.min(1, ladder.length - 1)];
  add(top, null);
  for (const encoder of hardware.slice(0, 2)) add(top, encoder);
  if (middle && middle !== top) {
    add(middle, preferred || hardware[0] || null);
    add(middle, null);
  }
  if (low && low !== middle) {
    add(low, preferred || hardware[0] || null);
    add(low, null);
  }
  return attempts;
}

async function captureChild(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {env: options.env || process.env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '', settled = false;
    child.stdout?.setEncoding('utf8').on('data', d => {stdout = (stdout + d).slice(-2_000_000);});
    child.stderr?.setEncoding('utf8').on('data', d => {stderr = (stderr + d).slice(-2_000_000);});
    const timer = setTimeout(() => {try {process.kill(-child.pid, 'SIGTERM');} catch {}}, options.timeoutMs || 10000);
    child.once('error', error => {if (settled) return;settled = true;clearTimeout(timer);reject(error);});
    child.once('close', code => {if (settled) return;settled = true;clearTimeout(timer);if (code === 0) resolve({stdout, stderr});else reject(new Error(stderr || stdout || `进程退出：${code}`));});
  });
}

async function ensureScrcpyRemote(helper, serverPath, serverVersion) {
  if (!helper.device?.serial) throw new Error('手机未连接。');
  if (!serverPath) throw new Error('scrcpy 实时流组件未安装。');
  const remote = '/data/local/tmp/androidlink-scrcpy-server-v' + serverVersion + '.jar';
  // scrcpy cleanup=true deliberately unlinks the server jar shortly after startup, so every new server process must push it again.
  await helper.adb(['-s', helper.device.serial, 'push', serverPath, remote], {label: 'scrcpy-push', timeout: 60000, sensitiveOutput: true});
  return remote;
}

export async function listH264Encoders(helper, options = {}) {
  const serverPath = options.serverPath || helper.scrcpyServerPath, serverVersion = options.serverVersion || '4.1';
  if (!helper.device?.serial || !serverPath || !helper.adbPath) return [];
  const remote = await ensureScrcpyRemote(helper, serverPath, serverVersion);
  const args = ['-s', helper.device.serial, 'shell', 'CLASSPATH=' + remote, 'app_process', '/', 'com.genymobile.scrcpy.Server', serverVersion,
    'log_level=info', 'list_encoders=true', 'cleanup=true'];
  try {
    const result = await captureChild(helper.adbPath, args, {env: helper.env, timeoutMs: options.timeoutMs || 9000});
    return parseH264Encoders(result.stderr + '\n' + result.stdout);
  } catch (error) {
    return parseH264Encoders(String(error?.message || ''));
  }
}

export function streamEnvelope(type, payload = Buffer.alloc(0), timestamp = 0n) {
  if (!Object.values(STREAM_EVENT).includes(type)) throw new Error('未知视频事件。');
  if (!Buffer.isBuffer(payload)) payload = Buffer.from(payload);
  if (payload.length > 32 * 1024 * 1024) throw new Error('视频帧过大。');
  const header = Buffer.alloc(13);
  header[0] = type;
  header.writeBigUInt64BE(BigInt(timestamp), 1);
  header.writeUInt32BE(payload.length, 9);
  return Buffer.concat([header, payload]);
}

export class ScrcpyPacketParser {
  constructor(onEvent) {this.onEvent = onEvent;this.buffer = Buffer.alloc(0);this.codecRead = false;}
  feed(chunk) {
    if (!chunk?.length) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    for (;;) {
      if (!this.codecRead) {
        if (this.buffer.length < 4) return;
        const codecBytes = this.buffer.subarray(0, 4);
        if (codecBytes.equals(Buffer.from([0, 0, 0, 1]))) throw new Error('手机视频编码器拒绝了当前 H.264 配置。');
        if (codecBytes.equals(Buffer.alloc(4))) throw new Error('手机已禁用实时视频流。');
        const codec = codecBytes.toString('ascii');
        this.buffer = this.buffer.subarray(4);this.codecRead = true;
        if (codec !== 'h264') throw new Error('实时流不是 H.264：' + codec);
        continue;
      }
      if (this.buffer.length < 12) return;
      const header = this.buffer.subarray(0, 12);
      if (header[0] & 0x80) {
        const width = header.readUInt32BE(4), height = header.readUInt32BE(8);
        this.buffer = this.buffer.subarray(12);
        if (!width || !height || width > 16384 || height > 16384) throw new Error('实时流尺寸无效。');
        this.onEvent({type: 'resize', width, height});
        continue;
      }
      const ptsFlags = header.readBigUInt64BE(0), size = header.readUInt32BE(8);
      if (!size || size > 32 * 1024 * 1024) throw new Error('实时流帧长度异常。');
      if (this.buffer.length < 12 + size) return;
      const payload = Buffer.from(this.buffer.subarray(12, 12 + size));
      this.buffer = this.buffer.subarray(12 + size);
      this.onEvent({type: (ptsFlags & CONFIG_FLAG) ? 'config' : (ptsFlags & KEY_FLAG) ? 'key' : 'delta',
        timestamp: ptsFlags & PTS_MASK, payload});
    }
  }
}

async function connectWithRetry(port, timeoutMs = 6000) {
  const started = Date.now();let last;
  while (Date.now() - started < timeoutMs) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = net.createConnection({host: '127.0.0.1', port});
        socket.setNoDelay(true);
        const timer = setTimeout(() => {socket.destroy();reject(new Error('视频端口连接超时。'));}, 700);
        socket.once('connect', () => {clearTimeout(timer);resolve(socket);});
        socket.once('error', error => {clearTimeout(timer);reject(error);});
      });
    } catch (error) {last = error;await new Promise(r => setTimeout(r, 120));}
  }
  throw last || new Error('无法连接实时视频流。');
}


function compactProcessError(prefix, stderr, fallback = '') {
  const tail = String(stderr || '').trim().replace(/\s+/g, ' ').slice(-900);
  return `${prefix}${tail ? '：' + tail : fallback ? '：' + String(fallback).slice(0, 500) : ''}`;
}

async function waitForStableSocket(socket, child, timeoutMs = 260) {
  if (!socket || socket.destroyed) throw new Error('socket 在稳定性检查前已关闭。');
  await new Promise((resolve, reject) => {
    let settled = false;
    const done = error => {
      if (settled) return;settled = true;clearTimeout(timer);
      socket.off('close', onClose);socket.off('error', onError);child?.off?.('close', onChildClose);
      error ? reject(error) : resolve();
    };
    const onClose = () => done(new Error('socket 建立后立即关闭。'));
    const onError = error => done(new Error('socket 稳定性检查失败：' + error.message));
    const onChildClose = code => done(new Error('scrcpy 进程在 socket 建立后立即退出：' + code));
    const timer = setTimeout(() => done(), Math.max(80, Number(timeoutMs) || 260));
    socket.once('close', onClose);socket.once('error', onError);child?.once?.('close', onChildClose);
  });
}

export async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {const port = server.address().port;server.close(error => error ? reject(error) : resolve(port));});
  });
}

export class ScrcpyVideoStream {
  constructor(helper, options = {}) {
    this.helper = helper;this.serverPath = options.serverPath || helper.scrcpyServerPath;
    this.serverVersion = options.serverVersion || '4.1';this.onEvent = options.onEvent || (() => {});
    this.onError = options.onError || (() => {});this.onControlError = options.onControlError || (() => {});this.controlEnabled = options.controlEnabled !== false;this.child = null;this.socket = null;this.controlSocket = null;this.forwardPort = null;this.stopped = false;this.touchDown = false;
    this.stage = 'idle';this.startedAt = null;this.profile = null;this.stderrTail = '';this.lastError = '';
  }
  diagnostic() {return {stage:this.stage,startedAt:this.startedAt,profile:this.profile,forwardPort:this.forwardPort,serverPid:this.child?.pid||null,
    videoSocket:Boolean(this.socket&&!this.socket.destroyed),controlSocket:Boolean(this.controlSocket&&!this.controlSocket.destroyed),stderrTail:this.stderrTail.slice(-1200),lastError:this.lastError||null};}
  async startProfile(profile, readyTimeoutMs = 2600) {
    if (!this.helper.device?.serial || !this.helper.session) throw new Error('手机未连接。');
    if (!this.serverPath) throw new Error('scrcpy 实时流组件未安装。');
    this.stopped = false;this.startedAt=new Date().toISOString();this.profile={...profile};this.stderrTail='';this.lastError='';this.stage='prepare';
    const scid = crypto.randomBytes(4).readUInt32BE() & 0x7fffffff;
    const scidHex = scid.toString(16).padStart(8, '0'), socketName = 'scrcpy_' + scidHex;
    this.forwardPort = await findFreePort();this.stage='push-server';
    const remote = await ensureScrcpyRemote(this.helper, this.serverPath, this.serverVersion);
    this.stage='adb-forward';
    await this.helper.adb(['-s', this.helper.device.serial, 'forward', 'tcp:' + this.forwardPort, 'localabstract:' + socketName], {label: 'scrcpy-forward', timeout: 15000, sensitiveOutput: true});
    const args = ['-s', this.helper.device.serial, 'shell', 'CLASSPATH=' + remote, 'app_process', '/', 'com.genymobile.scrcpy.Server', this.serverVersion,
      'scid=' + scidHex, 'log_level=info', 'video=true', 'audio=false', 'control=' + (this.controlEnabled ? 'true' : 'false'), 'video_codec=h264',
      'video_bit_rate=' + profile.bitRate, 'max_size=' + profile.maxSize, 'max_fps=' + profile.fps,
      ...(profile.encoder ? ['video_encoder=' + profile.encoder] : []),
      'tunnel_forward=true', 'send_device_meta=false', 'send_dummy_byte=false', 'send_codec_meta=true', 'send_frame_meta=true', 'cleanup=true'];
    this.stage='spawn-server';
    this.child = spawn(this.helper.adbPath, args, {env: this.helper.env, shell: false, detached: true, stdio: ['ignore', 'ignore', 'pipe']});
    this.helper.children?.add(this.child);let stderr = '', earlyExit = null, exitReject;
    const earlyExitPromise = new Promise((_, reject) => {exitReject = reject;});
    this.child.stderr?.setEncoding('utf8').on('data', d => {stderr = (stderr + d).slice(-24000);this.stderrTail=stderr;});
    this.child.once('close', code => {this.helper.children?.delete(this.child);this.stage='server-exit';earlyExit = new Error(compactProcessError('scrcpy 视频进程退出',stderr,String(code)));this.lastError=earlyExit.message;exitReject(earlyExit);if (!this.stopped) this.onError(earlyExit);});
    this.stage='video-socket';
    try {this.socket = await Promise.race([connectWithRetry(this.forwardPort, 5000), earlyExitPromise]);} catch (error) {const wrapped=new Error(compactProcessError('scrcpy 视频 socket 启动失败',stderr,error.message));wrapped.stage=this.stage;this.lastError=wrapped.message;await this.stop();throw wrapped;}
    if (this.controlEnabled) {
      this.stage='control-socket';
      try {this.controlSocket = await Promise.race([connectWithRetry(this.forwardPort, 3200), earlyExitPromise]);await waitForStableSocket(this.controlSocket,this.child,220);}
      catch (error) {const e = new Error(compactProcessError('scrcpy 控制 socket 启动失败',stderr,error.message));e.controlUnavailable = true;e.stage=this.stage;this.lastError=e.message;await this.stop();throw e;}
      this.controlSocket.on('data', () => {});
      let controlFailureReported = false;
      const reportControlFailure = error => {if (this.stopped || controlFailureReported) return;controlFailureReported = true;this.stage='control-error';this.lastError=String(error?.message||error);this.controlSocket = null;this.touchDown = false;this.onControlError(error);};
      this.controlSocket.on('error', error => reportControlFailure(new Error('scrcpy 控制通道中断：' + error.message)));
      this.controlSocket.on('close', () => reportControlFailure(new Error('scrcpy 控制通道已关闭。')));
    }

    this.stage='video-header';
    let readyResolve, readyReject, gotResize = false, gotConfig = false;
    const ready = new Promise((resolve, reject) => {readyResolve = resolve;readyReject = reject;});
    const parser = new ScrcpyPacketParser(event => {
      if (event.type === 'resize') gotResize = true;
      if (event.type === 'config') gotConfig = true;
      this.onEvent(event);
      if (gotResize && gotConfig) readyResolve();
    });
    const fail = error => {const wrapped=new Error(compactProcessError(String(error?.message||error),stderr));wrapped.stage=this.stage;this.lastError=wrapped.message;try {readyReject(wrapped);} catch {} if (!this.stopped) this.onError(wrapped);};
    this.socket.on('data', chunk => {try {parser.feed(chunk);} catch (error) {fail(error);this.stop();}});
    this.socket.on('error', error => {if (!this.stopped) fail(error);});
    this.socket.on('close', () => {if (!this.stopped) fail(earlyExit || new Error('实时视频流已断开'));});
    const timer = setTimeout(() => readyReject(new Error('scrcpy 已连接，但在限定时间内没有收到有效 H.264 视频头。' + (stderr.trim() ? ' ' + stderr.trim().slice(-500) : ''))), readyTimeoutMs);
    try {await ready;} catch (error) {if(!error.stage)error.stage=this.stage;await this.stop();throw error;} finally {clearTimeout(timer);}
    this.stage='streaming';return profile;
  }
  canControl() {return Boolean(this.controlEnabled && this.controlSocket && !this.controlSocket.destroyed);}
  touchMessage(action, point, screenSize) {
    const actions = {down: 0, up: 1, move: 2};
    if (!(action in actions)) throw new Error('触摸动作无效。');
    const width = Math.floor(Number(screenSize?.width)), height = Math.floor(Number(screenSize?.height));
    const x = Math.floor(Number(point?.x)), y = Math.floor(Number(point?.y));
    if (![width, height].every(v => Number.isFinite(v) && v > 0 && v <= 65535) || ![x, y].every(Number.isFinite)) throw new Error('触摸坐标无效。');
    const out = Buffer.alloc(32);out[0] = 2;out[1] = actions[action];
    out.writeBigUInt64BE(0xfffffffffffffffen, 2);
    out.writeInt32BE(Math.max(0, Math.min(width - 1, x)), 10);out.writeInt32BE(Math.max(0, Math.min(height - 1, y)), 14);
    out.writeUInt16BE(width, 18);out.writeUInt16BE(height, 20);out.writeUInt16BE(action === 'up' ? 0 : 0xffff, 22);
    out.writeUInt32BE(0, 24);out.writeUInt32BE(0, 28);return out;
  }
  async injectTouch(action, point, screenSize) {
    if (!this.canControl()) throw new Error('scrcpy 直连触控不可用。');
    const payload = this.touchMessage(action, point, screenSize);
    await new Promise((resolve, reject) => {
      const socket = this.controlSocket;if (!socket || socket.destroyed) return reject(new Error('scrcpy 直连触控不可用。'));
      socket.write(payload, error => error ? reject(error) : resolve());
    });
    this.touchDown = action === 'down' ? true : action === 'up' ? false : this.touchDown;
  }
  async releaseTouch(point = {x: 0, y: 0}, screenSize = {width: 1, height: 1}) {
    if (!this.touchDown || !this.canControl()) {this.touchDown = false;return;}
    try {await this.injectTouch('up', point, screenSize);} catch {} finally {this.touchDown = false;}
  }
  async stop() {
    if (this.stopped) return;this.stopped = true;this.stage='stopping';
    if (this.controlSocket) {this.controlSocket.destroy();this.controlSocket = null;}this.touchDown = false;
    if (this.socket) {this.socket.destroy();this.socket = null;}
    if (this.child) {try {this.helper.terminateChild(this.child);} catch {}this.helper.children?.delete(this.child);this.child = null;}
    if (this.forwardPort && this.helper.device?.serial) {
      try {await this.helper.adb(['-s', this.helper.device.serial, 'forward', '--remove', 'tcp:' + this.forwardPort], {label: 'scrcpy-forward-remove', timeout: 5000, sensitiveOutput: true});} catch {}
    }
    this.forwardPort = null;this.stage='stopped';
  }
}

export class ScrcpyControlStream {
  constructor(helper, options = {}) {
    this.helper = helper;this.serverPath = options.serverPath || helper.scrcpyServerPath;this.serverVersion = options.serverVersion || '4.1';
    this.onError = options.onError || (() => {});this.child = null;this.controlSocket = null;this.forwardPort = null;this.stopped = false;this.touchDown = false;
    this.stage='idle';this.startedAt=null;this.stderrTail='';this.lastError='';this.failureReported=false;
  }
  diagnostic(){return {stage:this.stage,startedAt:this.startedAt,forwardPort:this.forwardPort,serverPid:this.child?.pid||null,
    controlSocket:Boolean(this.controlSocket&&!this.controlSocket.destroyed),stderrTail:this.stderrTail.slice(-1200),lastError:this.lastError||null};}
  async start(timeoutMs = 3200) {
    if (!this.helper.device?.serial || !this.helper.session) throw new Error('手机未连接。');
    this.stopped = false;this.startedAt=new Date().toISOString();this.stderrTail='';this.lastError='';this.failureReported=false;this.stage='push-server';
    const remote = await ensureScrcpyRemote(this.helper, this.serverPath, this.serverVersion);
    const scid = crypto.randomBytes(4).readUInt32BE() & 0x7fffffff, scidHex = scid.toString(16).padStart(8, '0'), socketName = 'scrcpy_' + scidHex;
    this.forwardPort = await findFreePort();this.stage='adb-forward';
    await this.helper.adb(['-s', this.helper.device.serial, 'forward', 'tcp:' + this.forwardPort, 'localabstract:' + socketName], {label: 'scrcpy-control-forward', timeout: 15000, sensitiveOutput: true});
    const args = ['-s', this.helper.device.serial, 'shell', 'CLASSPATH=' + remote, 'app_process', '/', 'com.genymobile.scrcpy.Server', this.serverVersion,
      'scid=' + scidHex, 'log_level=info', 'video=false', 'audio=false', 'control=true', 'clipboard_autosync=false',
      'tunnel_forward=true', 'send_device_meta=false', 'send_dummy_byte=false', 'cleanup=true'];
    this.stage='spawn-server';
    this.child = spawn(this.helper.adbPath, args, {env: this.helper.env, shell: false, detached: true, stdio: ['ignore', 'ignore', 'pipe']});
    this.helper.children?.add(this.child);let stderr = '', exitReject;
    const earlyExit = new Promise((_, reject) => {exitReject = reject;});
    this.child.stderr?.setEncoding('utf8').on('data', d => {stderr = (stderr + d).slice(-12000);this.stderrTail=stderr;});
    const reportFailure = error => {if (this.stopped || this.failureReported) return;this.failureReported=true;this.lastError=String(error?.message||error);this.onError(error);};
    this.child.once('close', code => {this.helper.children?.delete(this.child);this.stage='server-exit';const error = new Error(compactProcessError('scrcpy 控制进程退出',stderr,String(code)));this.lastError=error.message;exitReject(error);reportFailure(error);});
    this.stage='control-socket';
    try {this.controlSocket = await Promise.race([connectWithRetry(this.forwardPort, timeoutMs), earlyExit]);await waitForStableSocket(this.controlSocket,this.child,320);}
    catch (error) {const wrapped=new Error(compactProcessError('scrcpy 独立触控通道启动失败',stderr,error.message));wrapped.stage=this.stage;this.lastError=wrapped.message;await this.stop();throw wrapped;}
    this.controlSocket.on('data', () => {});
    this.controlSocket.on('error', error => {if (!this.stopped){this.stage='socket-error';const wrapped=new Error(compactProcessError('scrcpy 独立触控通道中断',stderr,error.message));this.lastError=wrapped.message;reportFailure(wrapped);}});
    this.controlSocket.on('close', () => {if (!this.stopped){this.stage='socket-closed';const wrapped=new Error(compactProcessError('scrcpy 独立触控通道已关闭',stderr));this.lastError=wrapped.message;reportFailure(wrapped);}});
    this.stage='ready';return this;
  }
  canControl() {return Boolean(this.controlSocket && !this.controlSocket.destroyed);}
  touchMessage(action, point, screenSize) {return ScrcpyVideoStream.prototype.touchMessage.call(this, action, point, screenSize);}
  injectTouch(action, point, screenSize) {return ScrcpyVideoStream.prototype.injectTouch.call(this, action, point, screenSize);}
  releaseTouch(point, screenSize) {return ScrcpyVideoStream.prototype.releaseTouch.call(this, point, screenSize);}
  async stop() {
    if (this.stopped) return;this.stopped = true;this.stage='stopping';
    if (this.controlSocket) {this.controlSocket.destroy();this.controlSocket = null;}this.touchDown = false;
    if (this.child) {try {this.helper.terminateChild(this.child);} catch {}this.helper.children?.delete(this.child);this.child = null;}
    if (this.forwardPort && this.helper.device?.serial) {try {await this.helper.adb(['-s', this.helper.device.serial, 'forward', '--remove', 'tcp:' + this.forwardPort], {label: 'scrcpy-control-forward-remove', timeout: 5000, sensitiveOutput: true});} catch {}}
    this.forwardPort = null;this.stage='stopped';
  }
}

export function eventToEnvelope(event) {
  if (event.type === 'resize') {
    const payload = Buffer.alloc(8);payload.writeUInt32BE(event.width, 0);payload.writeUInt32BE(event.height, 4);
    return streamEnvelope(STREAM_EVENT.RESIZE, payload, 0n);
  }
  const type = event.type === 'config' ? STREAM_EVENT.CONFIG : event.type === 'key' ? STREAM_EVENT.KEY : STREAM_EVENT.DELTA;
  return streamEnvelope(type, event.payload, event.timestamp || 0n);
}
