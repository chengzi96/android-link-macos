import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {semanticScreenshotLabel, semanticScreenshotFilename, screenPoint, preciseDragActions, quickSwipeActions, startControlServer, resolveControlAssetDirectory, videoSizeNeedsRectRefresh, touchRetryDelay}
  from '../src/control.mjs';

const source = `<?xml version="1.0"?><hierarchy>
  <android.widget.FrameLayout package="com.tencent.mm">
    <android.widget.TextView resource-id="com.tencent.mm:id/title" text="登录"/>
    <android.widget.EditText text="验证码"/>
    <android.widget.TextView text="验证码错误"/>
  </android.widget.FrameLayout>
</hierarchy>`;

function pngBase64(width = 1080, height = 2400, fill = 1) {
  const png = Buffer.alloc(256, fill);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(png, 0);
  png.writeUInt32BE(width, 16);png.writeUInt32BE(height, 20);
  return png.toString('base64');
}

function auth(server) {
  const page = new URL(server.url), token = page.hash.slice(1);
  return {token, jsonHeaders: {'X-AndroidLink-Token': token, 'Content-Type': 'application/json'}, headers: {'X-AndroidLink-Token': token}};
}

async function post(server, headers, route, body = {}) {
  return fetch(server.origin + '/api/' + route, {method: 'POST', headers, body: JSON.stringify(body)});
}



test('common operations group system panels, capture tools and refresh in the intended order', () => {
  const html = fs.readFileSync(new URL('../src/control.html', import.meta.url), 'utf8');
  const system = html.indexOf('class="system-actions"'), panels = html.indexOf('class="panel-actions"'), media = html.indexOf('class="media-actions"'), refresh = html.indexOf('id="refresh"'), swipes = html.indexOf('class="swipes"');
  assert.ok(system >= 0 && system < panels && panels < media && media < refresh && refresh < swipes);
  assert.match(html, /class="panel-actions"><button id="notifications">通知栏<\/button><button id="quickSettings">快捷设置<\/button><button id="collapsePanel">收起面板<\/button>/);
  assert.match(html, /class="media-actions"><button id="save" class="primary">保存截图<\/button><button id="record" class="record-button">● 开始录屏<\/button>/);
  assert.match(html, /<button id="refresh" class="refresh-button">刷新画面<\/button>/);
});

test('notification shade, quick settings and collapse use explicit Android statusbar commands', async t => {
  const calls = [];
  const helper = {
    session: 'statusbar-session', base: 'http://127.0.0.1:4723', screenRect: {x:0,y:0,width:1080,height:2400},
    device: {serial:'SERIAL-PRIVATE', model:'Test', os:'12'}, state:{}, save(){}, knownSecrets:[],
    async adb(args, options){calls.push({args, options});return '';}, async command(){return '';}, async disconnect(){this.session=null;}
  };
  const shotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'android-statusbar-test-'));
  const server = await startControlServer(helper, {screenshotRoot: shotRoot});
  t.after(async () => {await server.close();fs.rmSync(shotRoot,{recursive:true,force:true});});
  const {jsonHeaders} = auth(server);
  for (const [route, command] of [['notifications','expand-notifications'],['quick-settings','expand-settings'],['collapse-panel','collapse']]) {
    const response = await post(server, jsonHeaders, route);assert.equal(response.status, 200, route);
    assert.equal(calls.at(-1).args.at(-1), command, route);
    assert.deepEqual(calls.at(-1).args.slice(0,5), ['-s','SERIAL-PRIVATE','shell','cmd','statusbar']);
  }
});

test('realtime touch recovery uses fast bounded retry backoff', () => {
  assert.equal(touchRetryDelay(0), 1500);
  assert.equal(touchRetryDelay(1), 3000);
  assert.equal(touchRetryDelay(2), 8000);
  assert.equal(touchRetryDelay(20), 30000);
  assert.equal(touchRetryDelay(1, [30, 60]), 60);
});

test('semantic screenshot names describe the screen and error state', () => {
  assert.equal(semanticScreenshotLabel(source), '登录页_验证码错误');
  assert.equal(semanticScreenshotFilename(source, new Date(2026, 8, 6, 4, 5, 6), 7), '20260906-040506_登录页_验证码错误_007.png');
  const privateSource = '<hierarchy><node package="com.example.app" text="sample.user@example.test"/><node text="15500000000"/></hierarchy>';
  assert.equal(semanticScreenshotLabel(privateSource).includes('test'), false);
  assert.equal(semanticScreenshotLabel(privateSource).includes('15500000000'), false);
});



test('precise drag preserves the requested distance and suppresses release fling', () => {
  const rect = {width: 1080, height: 2400};
  const gesture = preciseDragActions({x: .5, y: .7}, {x: .5, y: .5}, rect, 40);
  assert.deepEqual(gesture.from, {x: 540, y: 1680});
  assert.deepEqual(gesture.to, {x: 540, y: 1200});
  assert.equal(gesture.duration, 180);
  const actions = gesture.body.actions[0].actions;
  assert.deepEqual(actions[0], {type: 'pointerMove', duration: 0, x: 540, y: 1680, origin: 'viewport'});
  assert.deepEqual(actions[2], {type: 'pointerMove', duration: 180, x: 540, y: 1200, origin: 'viewport'});
  assert.deepEqual(actions[3], {type: 'pause', duration: 120});
  assert.deepEqual(actions[4], {type: 'pointerUp', button: 0});
  assert.equal(1680 - 1200, 480, 'device drag delta must equal mapped pointer delta');
});



test('quick swipe buttons follow finger-motion direction with explicit W3C touch coordinates', () => {
  const rect = {width: 1000, height: 2000};
  const up = quickSwipeActions('up', rect), down = quickSwipeActions('down', rect);
  const left = quickSwipeActions('left', rect), right = quickSwipeActions('right', rect);
  assert.deepEqual(up.from, {x: 500, y: 1500});assert.deepEqual(up.to, {x: 500, y: 500});
  assert.deepEqual(down.from, {x: 500, y: 500});assert.deepEqual(down.to, {x: 500, y: 1500});
  assert.deepEqual(left.from, {x: 750, y: 1000});assert.deepEqual(left.to, {x: 250, y: 1000});
  assert.deepEqual(right.from, {x: 250, y: 1000});assert.deepEqual(right.to, {x: 750, y: 1000});
  assert.equal(down.body.actions[0].actions[2].y > down.body.actions[0].actions[0].y, true, 'down means the finger physically moves downward');
  assert.throws(() => quickSwipeActions('diagonal', rect), /滑动方向无效/);
});

test('screen coordinates are bounded to the actual phone rectangle', () => {
  assert.deepEqual(screenPoint({x: 1, y: 1}, {width: 1080, height: 2400}), {x: 1079, y: 2399});
  assert.throws(() => screenPoint({x: -1, y: 0}, {width: 1, height: 1}), /坐标无效/);
});

test('realtime stream resize invalidates the Appium rect cache when orientation or stream size changes', () => {
  const portrait = {width: 1080, height: 2400};
  assert.equal(videoSizeNeedsRectRefresh(null, {width: 864, height: 1920}, portrait), false);
  assert.equal(videoSizeNeedsRectRefresh({width: 864, height: 1920}, {width: 1920, height: 864}, portrait), true);
  assert.equal(videoSizeNeedsRectRefresh({width: 864, height: 1920}, {width: 900, height: 1920}, portrait), true);
  assert.equal(videoSizeNeedsRectRefresh(null, {width: 1920, height: 864}, portrait), true);
});


test('control assets fall back to a complete installed resource directory', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-control-assets-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const broken = path.join(root, 'broken'), complete = path.join(root, 'complete');
  fs.mkdirSync(broken);fs.mkdirSync(complete);
  for (const file of ['control.html', 'control.js', 'control.css', 'refresh-scheduler.mjs', 'stream-client.mjs', 'stream-recovery.mjs', 'video-stream.mjs', 'mjpeg-stream.mjs']) fs.writeFileSync(path.join(complete, file), file);
  assert.equal(resolveControlAssetDirectory([broken, complete]), complete);
  fs.rmSync(path.join(complete, 'control.html'));
  assert.throws(() => resolveControlAssetDirectory([broken, complete]), /控制页资源不完整/);
});

test('control server saves original PNG with semantic filename and local token', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-control-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const png = pngBase64(), calls = [];
  const helper = {
    session: 'session-1', base: 'http://127.0.0.1:4723', connectedAt: new Date().toISOString(), screenRect: {x: 0, y: 0, width: 1080, height: 2400},
    device: {model: 'Pixel 9', os: '15'}, knownSecrets: [],
    async http(base, route, method, body) {
      calls.push({route, method, body});
      if (route.endsWith('/window/rect')) return {x: 0, y: 0, width: 1080, height: 2400};
      if (route.endsWith('/screenshot')) return png;
      if (route.endsWith('/source')) return source;
      if (route.endsWith('/execute/sync')) return null;
      throw new Error('unexpected route ' + route);
    },
    async reconnect() {this.session = 'session-2';}, async disconnect() {this.session = null;this.screenRect = null;},
    async command() {return '';},
  };
  const server = await startControlServer(helper, {screenshotRoot: root});
  t.after(() => server.close());
  const {headers, jsonHeaders} = auth(server);
  const denied = await fetch(server.origin + '/api/status');
  assert.equal(denied.status, 403);
  const status = await fetch(server.origin + '/api/status', {headers}).then(response => response.json());
  assert.equal(status.model, 'Pixel 9');
  const preview = await fetch(server.origin + '/api/screenshot', {headers});
  assert.equal(preview.status, 200);assert.equal(preview.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await preview.arrayBuffer()).toString('base64'), png);
  const savedResponse = await post(server, jsonHeaders, 'save-screenshot');
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.match(saved.fileName, /_登录页_验证码错误_001\.png$/);
  const disk = fs.readFileSync(path.join(saved.directory, saved.fileName));
  assert.equal(disk.toString('base64'), png);
  assert.equal(fs.statSync(path.join(saved.directory, saved.fileName)).mode & 0o777, 0o600);
  assert.equal(calls.some(call => call.route.endsWith('/source')), true);
});

test('only one live screenshot is allowed and a control command cancels stale refresh work', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-single-frame-test-'));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  let screenshotCalls = 0, aborted = 0;
  const helper = {
    session: 'session-1', base: 'http://127.0.0.1:4723', screenRect: {x: 0, y: 0, width: 1080, height: 2400}, device: {model: 'Test', os: '15'}, knownSecrets: [],
    async http(base, route, method, body, timeout, signal) {
      if (route.endsWith('/screenshot')) {
        screenshotCalls++;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(pngBase64()), 250);
          signal?.addEventListener('abort', () => {aborted++;clearTimeout(timer);reject(new DOMException('Aborted', 'AbortError'));}, {once: true});
        });
      }
      if (route.endsWith('/execute/sync')) return null;
      throw new Error('unexpected route ' + route);
    },
    async disconnect() {this.session = null;}, async command() {return '';},
  };
  const server = await startControlServer(helper, {screenshotRoot: root});t.after(() => server.close());
  const {headers, jsonHeaders} = auth(server);
  const first = fetch(server.origin + '/api/screenshot', {headers});
  await new Promise(resolve => setTimeout(resolve, 25));
  const second = await fetch(server.origin + '/api/screenshot', {headers});
  assert.equal(second.status, 429);
  const tap = await post(server, jsonHeaders, 'tap', {x: .5, y: .5});
  assert.equal(tap.status, 200);
  const firstResponse = await first;assert.equal(firstResponse.status, 409);
  assert.equal(screenshotCalls, 1);assert.equal(aborted, 1);
});

test('live screenshot timeout does not permanently block later refreshes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-frame-timeout-test-'));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  let screenshotCalls = 0;
  const helper = {
    session: 'session-1', base: 'http://127.0.0.1:4723', screenRect: {x: 0, y: 0, width: 1080, height: 2400}, device: {model: 'Test', os: '15'}, knownSecrets: [],
    async http(base, route, method, body, timeout) {
      if (!route.endsWith('/screenshot')) throw new Error('unexpected route ' + route);
      screenshotCalls++;
      if (screenshotCalls === 1) {await new Promise(resolve => setTimeout(resolve, timeout + 15));throw new Error('Appium request timeout');}
      return pngBase64();
    }, async disconnect() {this.session = null;}, async command() {return '';},
  };
  const server = await startControlServer(helper, {screenshotRoot: root, liveScreenshotTimeoutMs: 35});t.after(() => server.close());
  const {headers} = auth(server);
  const timedOut = await fetch(server.origin + '/api/screenshot', {headers});assert.equal(timedOut.status, 408);
  const recovered = await fetch(server.origin + '/api/screenshot', {headers});assert.equal(recovered.status, 200);
  assert.equal(screenshotCalls, 2);
});

test('screen size cache avoids repeated window rect calls and refreshes after rotation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-rect-cache-test-'));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  let landscape = false, rectCalls = 0;const executeBodies = [];
  const helper = {
    session: 'session-1', base: 'http://127.0.0.1:4723', screenRect: {x: 0, y: 0, width: 1080, height: 2400}, device: {model: 'Test', os: '15'}, knownSecrets: [],
    async http(base, route, method, body) {
      if (route.endsWith('/screenshot')) return landscape ? pngBase64(2400, 1080, 2) : pngBase64(1080, 2400, 1);
      if (route.endsWith('/window/rect')) {rectCalls++;return landscape ? {x: 0, y: 0, width: 2400, height: 1080} : {x: 0, y: 0, width: 1080, height: 2400};}
      if (route.endsWith('/execute/sync')) {executeBodies.push(body);return null;}
      throw new Error('unexpected route ' + route);
    }, async disconnect() {this.session = null;}, async command() {return '';},
  };
  const server = await startControlServer(helper, {screenshotRoot: root});t.after(() => server.close());
  const {headers, jsonHeaders} = auth(server);
  assert.equal((await fetch(server.origin + '/api/screenshot', {headers})).status, 200);assert.equal(rectCalls, 0);
  assert.equal((await post(server, jsonHeaders, 'tap', {x: .5, y: .5})).status, 200);assert.equal(rectCalls, 0);
  assert.deepEqual(executeBodies.at(-1).args[0], {x: 540, y: 1200});
  landscape = true;
  const rotated = await fetch(server.origin + '/api/screenshot', {headers});assert.equal(rotated.status, 200);assert.equal(rectCalls, 1);
  assert.equal(rotated.headers.get('X-AndroidLink-Width'), '2400');assert.equal(rotated.headers.get('X-AndroidLink-Height'), '1080');
  assert.equal((await post(server, jsonHeaders, 'tap', {x: .5, y: .5})).status, 200);assert.equal(rectCalls, 1);
  assert.deepEqual(executeBodies.at(-1).args[0], {x: 1200, y: 540});
});

test('MJPEG browser resize synchronizes the Appium rect cache before later control input', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-mjpeg-size-sync-test-'));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  let rectCalls = 0;const executeBodies = [];
  const helper = {
    session: 'session-1', base: 'http://127.0.0.1:4723', screenRect: {x: 0, y: 0, width: 1080, height: 2400}, device: {model: 'Test', os: '15'}, knownSecrets: [],
    async http(base, route, method, body) {
      if (route.endsWith('/window/rect')) {rectCalls++;return {x: 0, y: 0, width: 2400, height: 1080};}
      if (route.endsWith('/execute/sync')) {executeBodies.push(body);return null;}
      throw new Error('unexpected route ' + route);
    }, async disconnect() {this.session = null;}, async command() {return '';},
  };
  const server = await startControlServer(helper, {screenshotRoot: root});t.after(() => server.close());
  const {jsonHeaders} = auth(server);
  const resized = await post(server, jsonHeaders, 'video-size', {width: 960, height: 432});assert.equal(resized.status, 200);
  for (let i = 0; i < 20 && rectCalls === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(rectCalls, 1, 'MJPEG orientation change must refresh cached phone dimensions');
  assert.equal((await post(server, jsonHeaders, 'tap', {x: .5, y: .5})).status, 200);
  assert.deepEqual(executeBodies.at(-1).args[0], {x: 1200, y: 540});
});

test('background H264 probe can coexist with MJPEG and be promoted without restarting the phone session', async t => {
  const net = await import('node:net');
  const http = await import('node:http');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-h264-promote-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const fakeAdb = path.join(root, 'adb');fs.writeFileSync(fakeAdb, '#!/bin/sh\nexec /bin/sleep 30\n');fs.chmodSync(fakeAdb, 0o700);
  const scrcpyServerPath = path.join(root, 'scrcpy-server');fs.writeFileSync(scrcpyServerPath, 'fake');
  const forwarded = new Map();
  const h264Config = Buffer.from('000000016764001f0000000168ee3c80', 'hex');
  const scrcpySession = (width, height) => {const b = Buffer.alloc(12);b[0] = 0x80;b.writeUInt32BE(width, 4);b.writeUInt32BE(height, 8);return b;};
  const scrcpyPacket = payload => {const h = Buffer.alloc(12);h.writeBigUInt64BE(1n << 62n, 0);h.writeUInt32BE(payload.length, 8);return Buffer.concat([h, payload]);};
  let scrcpyConnections = 0;
  const helper = {
    session: 'session-1', base: 'http://127.0.0.1:4723', screenRect: {x: 0, y: 0, width: 1080, height: 2400},
    device: {serial: 'test-device', model: 'Test', os: '15'}, knownSecrets: [], scrcpyServerPath, adbPath: fakeAdb, env: process.env, children: new Set(), state: {}, save() {},
    async http(base, route) {
      if (route.endsWith('/appium/settings')) return null;
      if (route.endsWith('/window/rect')) return {x: 0, y: 0, width: 1080, height: 2400};
      throw new Error('unexpected route ' + route);
    },
    async adb(args) {
      const spec = args.find(x => String(x).startsWith('tcp:'));
      if (args.includes('forward') && !args.includes('--remove') && spec) {
        const port = Number(spec.slice(4)), target = args.at(-1);
        if (String(target).startsWith('localabstract:scrcpy_')) {
          const server = net.createServer(socket => {socket.on('error', () => {});scrcpyConnections += 1;socket.write(Buffer.concat([Buffer.from('h264'), scrcpySession(720, 1600), scrcpyPacket(h264Config)]));});
          await new Promise((resolve, reject) => {server.once('error', reject);server.listen(port, '127.0.0.1', resolve);});forwarded.set(port, server);
        } else if (target === 'tcp:7810') {
          const jpeg = Buffer.from([0xff,0xd8,1,2,3,0xff,0xd9]);
          const server = http.createServer((req, res) => {res.writeHead(200, {'Content-Type': 'multipart/x-mixed-replace; boundary=--BoundaryString'});res.write(Buffer.concat([Buffer.from('--BoundaryString\r\nContent-Type: image/jpeg\r\nContent-Length: '+jpeg.length+'\r\n\r\n'), jpeg, Buffer.from('\r\n')]));});
          await new Promise((resolve, reject) => {server.once('error', reject);server.listen(port, '127.0.0.1', resolve);});forwarded.set(port, server);
        }
        return '';
      }
      if (args.includes('forward') && args.includes('--remove') && spec) {
        const port = Number(spec.slice(4)), server = forwarded.get(port);forwarded.delete(port);if (server) await new Promise(resolve => server.close(() => resolve()));return '';
      }
      return '60.0';
    },
    terminateChild(child) {try {child.kill('SIGTERM');} catch {}},
    async disconnect() {this.session = null;}, async command() {return '';},
  };
  const server = await startControlServer(helper, {screenshotRoot: root});t.after(async () => {await server.close();for (const srv of forwarded.values()) await new Promise(resolve => srv.close(() => resolve()));});
  const {headers, jsonHeaders} = auth(server);
  const mjpeg = await fetch(server.origin + '/api/mjpeg?fps=30', {headers});assert.equal(mjpeg.status, 200);
  const probe = await fetch(server.origin + '/api/stream?fps=60&probe=1', {headers});assert.equal(probe.status, 200, 'probe must be allowed while MJPEG is live');
  const streamId = probe.headers.get('x-androidlink-stream-id');assert.match(streamId, /^[a-f0-9]{24}$/);
  const promoted = await post(server, jsonHeaders, 'promote-stream', {streamId});assert.equal(promoted.status, 200);
  const result = await promoted.json();assert.equal(result.mode, 'h264');assert.equal(result.targetFps, 60);assert.equal(result.directTouch, true);
  const status = await fetch(server.origin + '/api/status', {headers}).then(r => r.json());assert.equal(status.h264Diagnostic.state, 'playing');assert.ok(status.h264Diagnostic.lastSuccessAt);
  await probe.body.cancel();await mjpeg.body.cancel().catch(() => {});
});


test('preview size preference defaults to medium and persists through the local helper state', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-preview-size-test-'));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  let saves = 0;
  const helper = {
    session: null, base: 'http://127.0.0.1:4723', screenRect: null, device: {model: 'Test', os: '15'}, knownSecrets: [], state: {},
    save() {saves++;}, async disconnect() {}, async command() {return '';},
  };
  const server = await startControlServer(helper, {screenshotRoot: root});t.after(() => server.close());
  const {headers, jsonHeaders} = auth(server);
  const initial = await fetch(server.origin + '/api/status', {headers}).then(r => r.json());
  assert.equal(initial.previewSize, 'medium');
  const changed = await post(server, jsonHeaders, 'ui-preference', {previewSize: 'large'});
  assert.equal(changed.status, 200);assert.deepEqual(await changed.json(), {previewSize: 'large'});
  assert.equal(helper.state.uiPreferences.previewSize, 'large');assert.equal(saves, 1);
  const remembered = await fetch(server.origin + '/api/status', {headers}).then(r => r.json());
  assert.equal(remembered.previewSize, 'large');
  const invalid = await post(server, jsonHeaders, 'ui-preference', {previewSize: 'giant'});
  assert.equal(invalid.status, 400);assert.match((await invalid.json()).error, /显示尺寸无效/);
});

test('MJPEG keeps playing while control-only touch retries and becomes realtime without reconnecting', async t => {
  const net = await import('node:net');
  const http = await import('node:http');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-touch-retry-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const fakeAdb = path.join(root, 'adb');fs.writeFileSync(fakeAdb, '#!/bin/sh\nexec /bin/sleep 30\n');fs.chmodSync(fakeAdb, 0o700);
  const scrcpyServerPath = path.join(root, 'scrcpy-server');fs.writeFileSync(scrcpyServerPath, 'fake');
  const forwarded = new Map(), sockets = new Set();let scrcpyAttempts = 0;
  const closeForward = async port => {const srv = forwarded.get(port);forwarded.delete(port);if (!srv) return;for (const socket of sockets) socket.destroy();await new Promise(resolve => srv.close(() => resolve()));};
  const helper = {
    session: 'session-1', base: 'http://127.0.0.1:4723', screenRect: {x: 0, y: 0, width: 1080, height: 2400},
    device: {serial: 'test-device', model: 'Test', os: '15'}, knownSecrets: [], scrcpyServerPath, adbPath: fakeAdb, env: process.env, children: new Set(), state: {}, save() {},
    async http(base, route) {if (route.endsWith('/appium/settings')) return null;if (route.endsWith('/window/rect')) return {x: 0, y: 0, width: 1080, height: 2400};throw new Error('unexpected route ' + route);},
    async adb(args) {
      const spec = args.find(x => String(x).startsWith('tcp:'));
      if (args.includes('forward') && args.includes('--remove') && spec) {await closeForward(Number(spec.slice(4)));return '';}
      if (args.includes('forward') && !args.includes('--remove') && spec) {
        const port = Number(spec.slice(4)), target = args.at(-1);
        if (target === 'tcp:7810') {
          const jpeg = Buffer.from([0xff,0xd8,1,2,3,0xff,0xd9]);
          const server = http.createServer((req, res) => {res.writeHead(200, {'Content-Type': 'multipart/x-mixed-replace; boundary=--BoundaryString'});res.write(Buffer.concat([Buffer.from('--BoundaryString\r\nContent-Type: image/jpeg\r\nContent-Length: '+jpeg.length+'\r\n\r\n'), jpeg, Buffer.from('\r\n')]));});
          await new Promise((resolve, reject) => {server.once('error', reject);server.listen(port, '127.0.0.1', resolve);});forwarded.set(port, server);
        } else if (String(target).startsWith('localabstract:scrcpy_')) {
          scrcpyAttempts += 1;
          if (scrcpyAttempts >= 2) {
            const server = net.createServer(socket => {sockets.add(socket);socket.on('close', () => sockets.delete(socket));socket.on('error', () => {});});
            await new Promise((resolve, reject) => {server.once('error', reject);server.listen(port, '127.0.0.1', resolve);});forwarded.set(port, server);
          }
        }
        return '';
      }
      return '60.0';
    },
    terminateChild(child) {try {child.kill('SIGTERM');} catch {}}, async disconnect() {this.session = null;}, async command() {return '';},
  };
  const server = await startControlServer(helper, {screenshotRoot: root, touchRetryDelaysMs: [30], touchStartTimeoutMs: 80});
  t.after(async () => {await server.close();for (const port of [...forwarded.keys()]) await closeForward(port);});
  const {headers} = auth(server);
  const mjpeg = await fetch(server.origin + '/api/mjpeg?fps=20', {headers});assert.equal(mjpeg.status, 200);
  let state = null;
  for (let i = 0; i < 80; i++) {state = await fetch(server.origin + '/api/status', {headers}).then(r => r.json());if (state.directTouchAvailable) break;await new Promise(resolve => setTimeout(resolve, 20));}
  assert.equal(state.directTouchAvailable, true, 'control-only channel should recover while MJPEG continues');
  assert.equal(state.touchControl.mode, 'scrcpy-control-only');assert.ok(scrcpyAttempts >= 2, 'first control-only failure must be retried');
  await mjpeg.body.cancel().catch(() => {});
});

test('recording API stays independent from control queue and exposes start stop local-save state', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-recording-api-test-'));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  let state = {phase: 'idle', maxDurationSeconds: 175, elapsedSeconds: 0, pendingPull: false, lastError: ''};
  const recorder = {
    localRoot: root, active: null,
    status() {return state;},
    async start() {this.active = {};state = {phase: 'recording', startedAt: new Date().toISOString(), maxDurationSeconds: 175, elapsedSeconds: 0, pendingPull: false, lastError: ''};return {startedAt: state.startedAt, maxDurationSeconds: 175};},
    async stop() {this.active = null;state = {phase: 'idle', maxDurationSeconds: 175, elapsedSeconds: 0, pendingPull: false, lastError: ''};return {fileName: '2026-09-07_设置页_录屏_001.mp4', directory: root, savedAt: new Date().toISOString(), startedAt: new Date().toISOString(), durationMs: 3000, sizeBytes: 12345};},
    async stopWithoutPull() {this.active = null;state = {phase: 'idle', maxDurationSeconds: 175, elapsedSeconds: 0, pendingPull: false, lastError: ''};},
  };
  const helper = {
    session: 'session-record', base: 'http://127.0.0.1:4723', screenRect: {x: 0, y: 0, width: 1080, height: 2400},
    device: {serial: 'device-record', model: 'Test', os: '12'}, state: {}, save() {}, knownSecrets: [],
    http: async (_base, route) => route.endsWith('/source') ? '<hierarchy><node package="com.android.settings" text="设置"/></hierarchy>' : null,
    command: async () => '', disconnect: async () => {},
  };
  const server = await startControlServer(helper, {recorder});t.after(() => server.close());const {headers, jsonHeaders} = auth(server);
  const initial = await fetch(server.origin + '/api/recording', {headers});assert.equal(initial.status, 200);assert.equal((await initial.json()).phase, 'idle');
  const started = await post(server, jsonHeaders, 'start-recording');assert.equal(started.status, 200);assert.equal((await started.json()).recording.phase, 'recording');
  const stopped = await post(server, jsonHeaders, 'stop-recording');assert.equal(stopped.status, 200);const stoppedJson = await stopped.json();assert.equal(stoppedJson.fileName.endsWith('.mp4'), true);assert.equal(stoppedJson.recording.items.length, 1);
});

test('recording API surfaces MediaCodec screenrecord failures instead of the generic unlock hint', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-recording-error-api-test-'));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const recorder = {
    localRoot: root, active: null,
    status() {return {phase: 'idle', maxDurationSeconds: 175, elapsedSeconds: 0, pendingPull: false, lastError: ''};},
    async start() {throw new Error('手机原生录屏启动失败：MediaCodec encoder resource unavailable');},
    async stopWithoutPull() {},
  };
  const helper = {
    session: 'session-record-error', base: 'http://127.0.0.1:4723', screenRect: {x: 0, y: 0, width: 1080, height: 2400},
    device: {serial: 'device-record-error', model: 'Test', os: '12'}, state: {}, save() {}, knownSecrets: [],
    http: async () => null, command: async () => '', disconnect: async () => {},
  };
  const server = await startControlServer(helper, {recorder});t.after(() => server.close());const {jsonHeaders} = auth(server);
  const response = await post(server, jsonHeaders, 'start-recording');assert.equal(response.status, 400);
  const body = await response.json();assert.match(body.error, /MediaCodec encoder resource unavailable/);assert.doesNotMatch(body.error, /请确认手机已解锁/);
});

test('page-source requests use a bounded Appium timeout instead of blocking controls for the generic 45s default', async t => {
  let sourceTimeout = null;
  const helper = {
    session: 'session-1', base: 'http://127.0.0.1:4723', screenRect: {x: 0, y: 0, width: 1080, height: 2400},
    device: {model: 'Test', os: '15'}, knownSecrets: [],
    async http(base, route, method, body, timeout) {
      if (route.endsWith('/source')) {sourceTimeout = timeout;return '<hierarchy />';}
      throw new Error('unexpected route ' + route);
    },
    async disconnect() {this.session = null;}, async command() {return '';},
  };
  const server = await startControlServer(helper);t.after(() => server.close());
  const {headers} = auth(server);
  const response = await fetch(server.origin + '/api/source', {headers});
  assert.equal(response.status, 200);
  assert.equal(sourceTimeout, 12000);
});

test('stopping a phone recording bounds semantic page-source lookup before saving the MP4', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-recording-stop-source-'));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  let sourceTimeout = null, stopCalls = 0;
  const recorder = {
    localRoot: root,
    active: {phase: 'recording'},
    status() {return this.active ? {phase: this.active.phase, startedAt: new Date().toISOString(), maxDurationSeconds: 175, elapsedSeconds: 1, pendingPull: false, lastError: '', profile: null} : {phase: 'idle', maxDurationSeconds: 175, elapsedSeconds: 0, pendingPull: false, lastError: '', profile: null};},
    async stop() {stopCalls++;this.active = null;return {fileName: 'test.mp4', directory: root, savedAt: new Date().toISOString(), startedAt: new Date().toISOString(), durationMs: 1, sizeBytes: 100, profile: null};},
    async stopWithoutPull() {this.active = null;},
  };
  const helper = {
    session: 'session-1', base: 'http://127.0.0.1:4723', screenRect: {x: 0, y: 0, width: 1080, height: 2400},
    device: {model: 'Test', os: '15'}, knownSecrets: [],
    async http(base, route, method, body, timeout) {
      if (route.endsWith('/source')) {sourceTimeout = timeout;return '<hierarchy><node package="com.android.settings" text="设置"/></hierarchy>';}
      throw new Error('unexpected route ' + route);
    },
    async disconnect() {this.session = null;}, async command() {return '';},
  };
  const server = await startControlServer(helper, {recorder});t.after(() => server.close());
  const {jsonHeaders} = auth(server);
  const response = await post(server, jsonHeaders, 'stop-recording');
  assert.equal(response.status, 200);
  assert.equal(sourceTimeout, 1500);
  assert.equal(stopCalls, 1);
});

test('advanced diagnostics exposes a redacted live monitor without phone serial or page content', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-diagnostics-test-'));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const helper = {
    session: 'session-diag', base: 'http://127.0.0.1:4723', connectedAt: new Date().toISOString(), screenRect: {x:0,y:0,width:1080,height:2400},
    device: {serial:'SECRET-SERIAL-123', model:'Pixel Test', os:'15'}, knownSecrets:['SECRET-SERIAL-123'], state:{uiPreferences:{}},
    deviceRef(){return 'a'.repeat(20);}, save(){}, diagnosticSummary(){return {tool:'test', note:'safe'};},
    async discoverDevices(){return {devices:[{ref:'b'.repeat(20),state:'device',model:'Pixel Test',os:'15'}],rememberedRef:null,selectedRef:'a'.repeat(20),autoConnect:false};},
    async http(){return null;}, async command(){return '';}, async disconnect(){this.session=null;},
  };
  const server = await startControlServer(helper, {screenshotRoot:root});t.after(() => server.close());
  const {headers} = auth(server);
  const devices = await fetch(server.origin + '/api/devices', {headers});assert.equal(devices.status,200);
  const response = await fetch(server.origin + '/api/diagnostics', {headers});assert.equal(response.status,200);
  const diagnostics = await response.json();
  assert.equal(diagnostics.summary.usbAdb.value,'device / connected');
  assert.equal(diagnostics.summary.session.value,'正常');
  assert.equal(diagnostics.events.some(event => event.code === 'control-server-ready'),true);
  const text = JSON.stringify(diagnostics);
  assert.equal(text.includes('SECRET-SERIAL-123'),false);
  assert.equal(text.includes('<hierarchy'),false);
});
