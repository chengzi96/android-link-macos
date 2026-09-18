import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {validSerial} from './core.mjs';

export const DEFAULT_RECORDING_LIMIT_SECONDS = 175;
export const REMOTE_RECORDING_DIRECTORY = '/sdcard/AndroidLink/recordings';

function stamp(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error('录屏时间无效。');
  const values = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value, index) => String(value).padStart(index ? 2 : 4, '0'));
  return `${values.slice(0, 3).join('-')}_${values.slice(3).join('-')}`;
}

export function safeRecordingLabel(value) {
  const clean = String(value || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, '')
    .replace(/[^\p{L}\p{N}._-]/gu, '').slice(0, 36);
  return clean || 'Android页面';
}

export function recordingFilename(label, date = new Date(), sequence = 1) {
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error('录屏序号无效。');
  return `${stamp(date)}_${safeRecordingLabel(label)}_录屏_${String(sequence).padStart(3, '0')}.mp4`;
}

export function isMp4Buffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  return buffer.subarray(4, 8).toString('ascii') === 'ftyp';
}

export function parseWmSize(raw) {
  const text = String(raw || '');
  const matches = [...text.matchAll(/(?:Override|Physical)?\s*size:\s*(\d+)x(\d+)/gi)];
  const match = matches.at(-1) || text.match(/\b(\d{3,5})x(\d{3,5})\b/);
  if (!match) return null;
  const width = Number(match[1]), height = Number(match[2]);
  if (![width, height].every(value => Number.isInteger(value) && value >= 240 && value <= 16384)) return null;
  return {width, height};
}

function even(value) {return Math.max(2, Math.floor(Number(value) / 2) * 2);}
function scaledSize(size, maxLongEdge) {
  if (!size?.width || !size?.height) return null;
  const longest = Math.max(size.width, size.height);
  if (longest <= maxLongEdge) return {width: even(size.width), height: even(size.height)};
  const scale = maxLongEdge / longest;
  return {width: even(size.width * scale), height: even(size.height * scale)};
}

export function screenrecordProfiles(size) {
  const profiles = [{id: 'native', label: '原生规格', args: []}];
  const add = (id, label, maxLongEdge, bitRate) => {
    const scaled = scaledSize(size, maxLongEdge);
    const sizeArg = scaled ? ['--size', `${scaled.width}x${scaled.height}`] : [];
    const args = [...sizeArg, '--bit-rate', String(bitRate)];
    const signature = args.join(' ');
    if (!profiles.some(profile => profile.args.join(' ') === signature)) profiles.push({id, label, args, size: scaled, bitRate});
  };
  add('compatible', '兼容高清', 1920, 8_000_000);
  add('safe', '兼容流畅', 1600, 6_000_000);
  return profiles.slice(0, 3);
}


function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function validateRemoteRecordingPath(remotePath) {
  const prefix = REMOTE_RECORDING_DIRECTORY + '/';
  const value = String(remotePath || '');
  if (!value.startsWith(prefix) || !/^androidlink-[0-9]+-[a-f0-9]{8}\.mp4$/i.test(value.slice(prefix.length))) {
    throw new Error('手机录屏临时路径无效。');
  }
  return value;
}

export function buildScreenrecordScript(profile, maxDurationSeconds, remotePath) {
  const duration = Math.max(1, Math.min(180, Math.floor(Number(maxDurationSeconds) || 0)));
  const target = validateRemoteRecordingPath(remotePath);
  const options = Array.isArray(profile?.args) ? profile.args.map(value => shellQuote(value)) : [];
  // Keep the phone MP4 as the final screenrecord argument. Android screenrecord rejects commands without it.
  const command = ['screenrecord', ...options, '--time-limit', String(duration), shellQuote(target)].join(' ');
  return [
    `${command} &`,
    'pid=$!',
    `printf '__ANDROIDLINK_PID__:%s\\n' "$pid"`,
    'wait "$pid"',
  ].join('\n') + '\n';
}

function ensurePrivateDirectory(directory) {
  const parent = path.dirname(directory);
  fs.mkdirSync(parent, {recursive: true, mode: 0o700});
  if (fs.existsSync(parent)) {
    const info = fs.lstatSync(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('录屏保存目录不安全，已停止保存。');
  }
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('录屏保存目录不安全，已停止保存。');
  try {fs.chmodSync(directory, 0o700);} catch {}
  return directory;
}

function wait(ms) {return new Promise(resolve => setTimeout(resolve, ms));}
function cleanFailureText(value, serial = '') {
  let text = String(value || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (serial) text = text.split(serial).join('[设备]');
  text = text.replace(/\/Users\/[^/\s"']+/g, '/Users/[用户]');
  return text.slice(-420) || 'screenrecord 未保持运行。';
}

function waitForClose(child, timeoutMs = 10000) {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise(resolve => {
    let settled = false;
    const done = () => {if (settled) return;settled = true;clearTimeout(timer);resolve();};
    const timer = setTimeout(done, timeoutMs);
    child.once('close', done);child.once('error', done);
  });
}

function waitForRemotePid(child, timeoutMs = 3500) {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', settled = false;
    const finish = (error, pid) => {
      if (settled) return;settled = true;clearTimeout(timer);
      child.stdout?.off('data', onOut);child.stderr?.off('data', onErr);child.off('close', onClose);child.off('error', onChildError);
      error ? reject(error) : resolve(pid);
    };
    const onOut = chunk => {
      stdout = (stdout + String(chunk)).slice(-4096);
      const match = stdout.match(/__ANDROIDLINK_PID__:(\d+)/);
      if (match && Number(match[1]) > 1) finish(null, Number(match[1]));
    };
    const onErr = chunk => {stderr = (stderr + String(chunk)).slice(-4096);};
    const onClose = code => finish(new Error(`手机原生录屏进程启动失败${code === null ? '' : `（${code}）`}：${stderr.trim().slice(-300) || 'screenrecord 未保持运行。'}`));
    const onChildError = error => finish(new Error('无法启动手机原生录屏：' + error.message));
    const timer = setTimeout(() => finish(new Error('启动手机原生录屏超时，未获得 screenrecord 进程。')), timeoutMs);
    child.stdout?.on('data', onOut);child.stderr?.on('data', onErr);child.once('close', onClose);child.once('error', onChildError);
  });
}

export class AndroidScreenRecorder {
  constructor(helper, options = {}) {
    this.helper = helper;
    this.spawnChild = options.spawnChild || spawn;
    this.localRoot = options.localRoot || path.join(os.homedir(), 'Movies', '安卓连接助手', '录屏');
    this.maxDurationSeconds = Math.max(30, Math.min(180, Number(options.maxDurationSeconds) || DEFAULT_RECORDING_LIMIT_SECONDS));
    this.startupSettleMs = Math.max(20, Math.min(2000, Number(options.startupSettleMs) || 900));
    this.active = null;
  }

  status() {
    const active = this.active;
    return active ? {
      phase: active.phase,
      startedAt: active.startedAt,
      maxDurationSeconds: this.maxDurationSeconds,
      elapsedSeconds: Math.max(0, Math.floor((Date.now() - new Date(active.startedAt).getTime()) / 1000)),
      pendingPull: active.phase === 'pending-pull',
      lastError: active.lastError || '',
      profile: active.profile ? {id: active.profile.id, label: active.profile.label, size: active.profile.size || null, bitRate: active.profile.bitRate || null} : null,
    } : {phase: 'idle', maxDurationSeconds: this.maxDurationSeconds, elapsedSeconds: 0, pendingPull: false, lastError: '', profile: null};
  }

  async readDisplaySize(serial) {
    try {
      const raw = await this.helper.adb(['-s', serial, 'shell', 'wm', 'size'], {label: 'recording-screen-size', timeout: 5000, sensitiveOutput: true});
      return parseWmSize(raw);
    } catch {return null;}
  }

  async startAttempt(serial, remotePath, profile) {
    const remoteScript = buildScreenrecordScript(profile, this.maxDurationSeconds, remotePath);
    // Avoid `adb shell sh -c <script>`: adb may flatten argv and make sh -c execute only `screenrecord`,
    // dropping the required output MP4 path. Feed the complete script over stdin instead.
    const child = this.spawnChild(this.helper.adbPath, ['-s', serial, 'shell', 'sh'], {
      env: this.helper.env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.helper.children?.add?.(child);
    let stderrTail = '';
    const captureErr = chunk => {stderrTail = (stderrTail + String(chunk)).slice(-8192);};
    child.stderr?.on('data', captureErr);
    const remotePidPromise = waitForRemotePid(child, 3500);
    try {
      if (!child.stdin || typeof child.stdin.end !== 'function') throw new Error('ADB shell 无法接收手机录屏脚本。');
      child.stdin.end(remoteScript);
      const remotePid = await remotePidPromise;
      await wait(this.startupSettleMs);
      if (child.exitCode !== null || child.signalCode) {
        throw new Error(`手机原生录屏使用“${profile.label}”启动后立即退出：${cleanFailureText(stderrTail, serial)}`);
      }
      return {child, remotePid, profile};
    } catch (error) {
      remotePidPromise.catch(() => {});
      try {if (child.pid) process.kill(-child.pid, 'SIGTERM');} catch {}
      await waitForClose(child, 1000).catch(() => {});
      this.helper.children?.delete?.(child);
      const detail = cleanFailureText(stderrTail || error?.message || error, serial);
      const wrapped = new Error(`“${profile.label}”失败：${detail}`);wrapped.cause = error;throw wrapped;
    } finally {child.stderr?.off('data', captureErr);}
  }

  async start() {
    if (this.active) throw new Error(this.active.phase === 'pending-pull' ? '上一段录屏尚未回传到 Mac，请先重试回传。' : '手机正在录屏。');
    const serial = this.helper.device?.serial;
    if (!validSerial(serial) || !this.helper.adbPath) throw new Error('当前没有可用于录屏的 Android 手机。');
    try {
      await this.helper.adb(['-s', serial, 'shell', 'mkdir', '-p', REMOTE_RECORDING_DIRECTORY], {label: 'recording-prepare', timeout: 8000, sensitiveOutput: true});
    } catch (error) {
      throw new Error('手机原生录屏准备失败：' + cleanFailureText(error?.message || error, serial));
    }
    const remotePath = `${REMOTE_RECORDING_DIRECTORY}/androidlink-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.mp4`;
    const displaySize = await this.readDisplaySize(serial);
    const failures = [];
    let started = null;
    for (const profile of screenrecordProfiles(displaySize)) {
      try {
        started = await this.startAttempt(serial, remotePath, profile);break;
      } catch (error) {
        failures.push(String(error?.message || error));
        await this.helper.adb(['-s', serial, 'shell', 'rm', '-f', remotePath], {label: 'recording-reset-temp', timeout: 5000, sensitiveOutput: true}).catch(() => {});
      }
    }
    if (!started) {
      const summary = failures.map((item, index) => `${index + 1}. ${item}`).join('；').slice(0, 1200);
      throw new Error('手机原生录屏启动失败。已自动尝试原生规格和兼容规格：' + (summary || 'screenrecord 未能保持运行。'));
    }
    const startedAt = new Date().toISOString();
    this.active = {phase: 'recording', serial, remotePath, remotePid: started.remotePid, child: started.child, profile: started.profile, startedAt, lastError: ''};
    started.child.once('close', () => {this.helper.children?.delete?.(started.child);if (this.active?.child === started.child && this.active.phase === 'recording') this.active.phase = 'pending-pull';});
    return {startedAt, maxDurationSeconds: this.maxDurationSeconds, profile: this.status().profile};
  }

  async stop({label = 'Android页面', date = new Date(), sequence = 1} = {}) {
    const active = this.active;
    if (!active) throw new Error('当前没有正在录制或等待回传的录屏。');
    if (active.phase === 'recording' || active.phase === 'stopping') {
      active.phase = 'stopping';
      try {
        await this.helper.adb(['-s', active.serial, 'shell', 'kill', '-INT', String(active.remotePid)], {label: 'recording-stop', timeout: 8000, sensitiveOutput: true});
      } catch {
        try {if (active.child?.pid) process.kill(-active.child.pid, 'SIGINT');} catch {}
      }
      await waitForClose(active.child, 9000);
      active.phase = 'pending-pull';
    }
    const directory = ensurePrivateDirectory(this.localRoot);
    let fileName = recordingFilename(label, date, sequence), destination = path.join(directory, fileName);
    for (let suffix = 2; fs.existsSync(destination) && suffix < 1000; suffix++) {
      fileName = recordingFilename(`${label}_${suffix}`, date, sequence);destination = path.join(directory, fileName);
    }
    if (fs.existsSync(destination)) throw new Error('无法生成不重复的录屏文件名。');
    const temporary = destination + `.part-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    try {
      await this.helper.adb(['-s', active.serial, 'pull', active.remotePath, temporary], {label: 'recording-pull', timeout: 180000, sensitiveOutput: true, progress: true});
      const info = fs.lstatSync(temporary);
      if (!info.isFile() || info.isSymbolicLink() || info.size < 32) throw new Error('回传的录屏文件无效。');
      const header = Buffer.alloc(12), fd = fs.openSync(temporary, 'r');
      try {fs.readSync(fd, header, 0, header.length, 0);} finally {fs.closeSync(fd);}
      if (!isMp4Buffer(header)) throw new Error('手机返回的录屏不是有效 MP4。');
      fs.chmodSync(temporary, 0o600);fs.renameSync(temporary, destination);fs.chmodSync(destination, 0o600);
      await this.helper.adb(['-s', active.serial, 'shell', 'rm', '-f', active.remotePath], {label: 'recording-cleanup', timeout: 8000, sensitiveOutput: true}).catch(() => {});
      const durationMs = Math.max(0, date.getTime() - new Date(active.startedAt).getTime());
      const result = {fileName, directory, savedAt: date.toISOString(), startedAt: active.startedAt, durationMs, sizeBytes: info.size, profile: active.profile || null};
      this.active = null;return result;
    } catch (error) {
      try {if (fs.existsSync(temporary)) fs.unlinkSync(temporary);} catch {}
      active.phase = 'pending-pull';active.lastError = '录屏已停止，但回传到 Mac 失败；手机临时文件仍保留，可再次重试回传。';
      const wrapped = new Error(active.lastError + ' ' + cleanFailureText(error?.message || error, active.serial));
      wrapped.cause = error;throw wrapped;
    }
  }

  async stopWithoutPull() {
    const active = this.active;if (!active) return;
    if (active.phase === 'recording' || active.phase === 'stopping') {
      try {await this.helper.adb(['-s', active.serial, 'shell', 'kill', '-INT', String(active.remotePid)], {label: 'recording-stop', timeout: 5000, sensitiveOutput: true});} catch {}
      await waitForClose(active.child, 5000);
      active.phase = 'pending-pull';
    }
  }
}
