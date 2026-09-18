import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {spawn as spawnProcess} from 'node:child_process';
import {AndroidScreenRecorder, recordingFilename, safeRecordingLabel, isMp4Buffer, parseWmSize, screenrecordProfiles, buildScreenrecordScript, REMOTE_RECORDING_DIRECTORY} from '../src/phone-recording.mjs';

function mp4Buffer() {
  const buffer = Buffer.alloc(64);
  buffer.writeUInt32BE(24, 0);buffer.write('ftyp', 4, 'ascii');buffer.write('isom', 8, 'ascii');
  return buffer;
}

function fakeChild() {
  const child = new EventEmitter();child.stdin = new PassThrough();child.stdout = new PassThrough();child.stderr = new PassThrough();child.pid = 43210;child.exitCode = null;child.signalCode = null;
  return child;
}

function captureStdin(child) {
  let text = '';
  child.stdin.on('data', chunk => {text += String(chunk);});
  return () => text;
}


test('recording filenames are local, semantic and filesystem-safe', () => {
  assert.equal(safeRecordingLabel(' 设置页 / 安全:*? '), '设置页安全');
  assert.equal(recordingFilename('设置页', new Date(2026, 8, 7, 11, 22, 33), 4), '2026-09-07_11-22-33_设置页_录屏_004.mp4');
  assert.equal(isMp4Buffer(mp4Buffer()), true);
  assert.equal(isMp4Buffer(Buffer.alloc(64)), false);
});

test('screenrecord script always keeps the phone MP4 as the final command argument and avoids nested sh -c', () => {
  const remotePath = '/sdcard/AndroidLink/recordings/androidlink-1788750000000-a1b2c3d4.mp4';
  const script = buildScreenrecordScript({args: ['--size', '864x1920', '--bit-rate', '8000000']}, 175, remotePath);
  const [commandLine, pidLine, printfLine, waitLine] = script.trimEnd().split('\n');
  assert.equal(commandLine, "screenrecord '--size' '864x1920' '--bit-rate' '8000000' --time-limit 175 '" + remotePath + "' &");
  assert.equal(pidLine, 'pid=$!');
  assert.equal(printfLine, `printf '__ANDROIDLINK_PID__:%s\\n' "$pid"`);
  assert.equal(waitLine, 'wait "$pid"');
  assert.doesNotMatch(script, /sh -c/);
  assert.throws(() => buildScreenrecordScript({args: []}, 60, '/sdcard/not-ours.mp4'), /临时路径无效/);
});

test('stdin-fed shell script preserves the output MP4 as screenrecord final argv in a real shell', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'android-recording-shell-test-'));
  t.after(() => fs.rmSync(temp, {recursive: true, force: true}));
  const logFile = path.join(temp, 'args.txt');
  const fakeScreenrecord = path.join(temp, 'screenrecord');
  fs.writeFileSync(fakeScreenrecord, '#!/bin/sh\nprintf "%s\n" "$@" > "$ANDROIDLINK_ARGS"\n');
  fs.chmodSync(fakeScreenrecord, 0o755);
  const remotePath = '/sdcard/AndroidLink/recordings/androidlink-1788750000001-deadbeef.mp4';
  const script = buildScreenrecordScript({args: ['--size', '864x1920', '--bit-rate', '8000000']}, 60, remotePath);
  const child = spawnProcess('/bin/sh', [], {
    env: {...process.env, PATH: temp + path.delimiter + process.env.PATH, ANDROIDLINK_ARGS: logFile},
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => {stdout += String(chunk);});
  child.stderr.on('data', chunk => {stderr += String(chunk);});
  child.stdin.end(script);
  const code = await new Promise((resolve, reject) => {child.once('error', reject);child.once('close', resolve);});
  assert.equal(code, 0, stderr);
  assert.match(stdout, /__ANDROIDLINK_PID__:\d+/);
  const argv = fs.readFileSync(logFile, 'utf8').trimEnd().split('\n');
  assert.deepEqual(argv.slice(0, 6), ['--size', '864x1920', '--bit-rate', '8000000', '--time-limit', '60']);
  assert.equal(argv.at(-1), remotePath);
});

test('native Android recorder starts screenrecord, stops exact pid, pulls MP4 to Mac and cleans remote only after success', async t => {
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'android-recording-test-'));
  t.after(() => fs.rmSync(localRoot, {recursive: true, force: true}));
  const child = fakeChild(), adbCalls = [], children = new Set();
  const helper = {
    device: {serial: 'device-123'}, adbPath: '/fake/adb', env: {}, children,
    adb: async args => {
      adbCalls.push(args);
      if (args[2] === 'pull') {
        fs.writeFileSync(args[4], mp4Buffer());return '1 file pulled';
      }
      if (args[2] === 'shell' && args[3] === 'kill') {
        child.exitCode = 0;queueMicrotask(() => child.emit('close', 0));return '';
      }
      return '';
    },
  };
  let writtenScript = '';
  const recorder = new AndroidScreenRecorder(helper, {localRoot, maxDurationSeconds: 60, spawnChild: (file, args) => {
    assert.equal(file, '/fake/adb');assert.deepEqual(args, ['-s', 'device-123', 'shell', 'sh']);
    child.stdin.on('data', chunk => {writtenScript += String(chunk);});
    queueMicrotask(() => child.stdout.write('__ANDROIDLINK_PID__:9876\n'));return child;
  }});
  const started = await recorder.start();assert.equal(started.maxDurationSeconds, 60);assert.equal(recorder.status().phase, 'recording');assert.equal(children.has(child), true);
  const firstLine = writtenScript.split('\n')[0];
  assert.match(firstLine, /^screenrecord --time-limit 60 '\/sdcard\/AndroidLink\/recordings\/androidlink-[0-9]+-[a-f0-9]{8}\.mp4' &$/);
  assert.doesNotMatch(writtenScript, /sh -c/);
  const stopped = await recorder.stop({label: '设置页', date: new Date(2026, 8, 7, 11, 30, 0), sequence: 1});
  assert.equal(stopped.fileName, '2026-09-07_11-30-00_设置页_录屏_001.mp4');
  assert.equal(fs.existsSync(path.join(localRoot, stopped.fileName)), true);assert.equal(recorder.status().phase, 'idle');
  const kill = adbCalls.find(args => args[2] === 'shell' && args[3] === 'kill');assert.deepEqual(kill.slice(-2), ['-INT', '9876']);
  const pull = adbCalls.find(args => args[2] === 'pull');assert.match(pull[3], new RegExp('^' + REMOTE_RECORDING_DIRECTORY.replaceAll('/', '\\/') + '/androidlink-'));
  const cleanup = adbCalls.find(args => args[2] === 'shell' && args[3] === 'rm');assert.ok(cleanup, 'remote MP4 must be removed after verified pull');
});

test('failed pull keeps a pending-pull state so the phone copy can be retried instead of deleted', async t => {
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'android-recording-retry-test-'));t.after(() => fs.rmSync(localRoot, {recursive: true, force: true}));
  const child = fakeChild(), adbCalls = [];
  const helper = {device: {serial: 'device-abc'}, adbPath: '/fake/adb', env: {}, children: new Set(), adb: async args => {
    adbCalls.push(args);if (args[2] === 'pull') throw new Error('USB temporarily unavailable');
    if (args[2] === 'shell' && args[3] === 'kill') {child.exitCode = 0;queueMicrotask(() => child.emit('close', 0));}return '';
  }};
  const recorder = new AndroidScreenRecorder(helper, {localRoot, maxDurationSeconds: 60, spawnChild: () => {queueMicrotask(() => child.stdout.write('__ANDROIDLINK_PID__:2222\n'));return child;}});
  await recorder.start();await assert.rejects(() => recorder.stop({label: '页面', date: new Date(), sequence: 1}), /手机临时文件仍保留/);
  assert.equal(recorder.status().phase, 'pending-pull');
  assert.equal(adbCalls.some(args => args[2] === 'shell' && args[3] === 'rm'), false, 'failed pull must never delete the phone copy');
});


test('screenrecord profiles derive compatible sizes from the connected phone instead of one fixed spec', () => {
  assert.deepEqual(parseWmSize('Physical size: 1080x2400\nOverride size: 1080x2400'), {width: 1080, height: 2400});
  const profiles = screenrecordProfiles({width: 1080, height: 2400});
  assert.equal(profiles[0].id, 'native');
  assert.equal(profiles[1].id, 'compatible');
  assert.deepEqual(profiles[1].size, {width: 864, height: 1920});
  assert.deepEqual(profiles[2].size, {width: 720, height: 1600});
});

test('recording automatically retries a compatible profile when native screenrecord exits immediately', async t => {
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'android-recording-fallback-test-'));t.after(() => fs.rmSync(localRoot, {recursive: true, force: true}));
  const children = [], adbCalls = [];
  const helper = {device: {serial: 'device-fallback'}, adbPath: '/fake/adb', env: {}, children: new Set(), adb: async args => {
    adbCalls.push(args);
    if (args[2] === 'shell' && args[3] === 'wm') return 'Physical size: 1080x2400\n';
    return '';
  }};
  const recorder = new AndroidScreenRecorder(helper, {localRoot, maxDurationSeconds: 60, startupSettleMs: 25, spawnChild: (_file, args) => {
    const child = fakeChild(), item = {child, args, script: ''};children.push(item);
    child.stdin.on('data', chunk => {item.script += String(chunk);});
    queueMicrotask(() => {
      child.stdout.write('__ANDROIDLINK_PID__:' + (3000 + children.length) + '\n');
      if (children.length === 1) {
        child.stderr.write('ERROR: Failed to configure video/avc encoder\n');
        child.exitCode = 1;child.emit('close', 1);
      }
    });
    return child;
  }});
  const started = await recorder.start();
  assert.equal(started.profile.id, 'compatible');
  assert.equal(children.length, 2);
  assert.deepEqual(children[1].args, ['-s', 'device-fallback', 'shell', 'sh']);
  assert.match(children[1].script, /'--size' '864x1920'/);
  assert.match(children[1].script, /'--bit-rate' '8000000'/);
  assert.match(children[1].script.split('\n')[0], /'\/sdcard\/AndroidLink\/recordings\/androidlink-[0-9]+-[a-f0-9]{8}\.mp4' &$/);
  await recorder.stopWithoutPull();
});

test('recording failure exposes the real screenrecord reason instead of a misleading unlock message', async t => {
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'android-recording-error-test-'));t.after(() => fs.rmSync(localRoot, {recursive: true, force: true}));
  const helper = {device: {serial: 'secret-serial'}, adbPath: '/fake/adb', env: {}, children: new Set(), adb: async args => {
    if (args[2] === 'shell' && args[3] === 'wm') return 'Physical size: 1080x2400\n';
    return '';
  }};
  const recorder = new AndroidScreenRecorder(helper, {localRoot, maxDurationSeconds: 60, startupSettleMs: 20, spawnChild: () => {
    const child = fakeChild();queueMicrotask(() => {child.stdout.write('__ANDROIDLINK_PID__:4444\n');child.stderr.write('MediaCodec encoder resource unavailable\n');child.exitCode = 1;child.emit('close', 1);});return child;
  }});
  await assert.rejects(() => recorder.start(), error => {
    assert.match(error.message, /MediaCodec encoder resource unavailable/);
    assert.match(error.message, /原生规格/);
    assert.doesNotMatch(error.message, /请确认手机已解锁/);
    assert.doesNotMatch(error.message, /secret-serial/);
    return true;
  });
});
