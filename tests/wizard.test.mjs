import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {Assistant, freePort, parseLocalControlUrl} from '../src/wizard.mjs';

function mockAdb(selectedPresent) {
  return async (file, args) => {
    if (args[0] === 'devices') return selectedPresent ?
      'List of devices attached\nSELECTED device model:Pixel_8 transport_id:1\nOTHER device model:Galaxy_S24 transport_id:2\n' :
      'List of devices attached\nOTHER device model:Galaxy_S24 transport_id:2\n';
    const property = args.at(-1);
    return {'ro.build.version.sdk': '35\n', 'ro.build.version.release': '15\n', 'ro.product.manufacturer': 'Google\n',
      'ro.product.brand': 'google\n', 'ro.product.model': 'Pixel 8\n'}[property] || '';
  };
}

test('reconnect keeps the remembered Android device when several are online', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-wizard-test-'));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const helper = new Assistant(root, {exec: mockAdb(true)});helper.state.lastDevice = 'SELECTED';
  const device = await helper.ensureSelectedDevice();
  assert.equal(device.serial, 'SELECTED');assert.equal(device.model, 'Pixel 8');
});

test('reconnect refuses to switch when remembered phone is absent', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-wizard-test-'));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const helper = new Assistant(root, {exec: mockAdb(false)});helper.state.lastDevice = 'SELECTED';
  await assert.rejects(() => helper.ensureSelectedDevice(), /不会自动切换设备/);
});

test('freePort returns a localhost port without taking ownership of other services', async () => {
  const port = await freePort(49100);assert.equal(Number.isInteger(port), true);assert.equal(port >= 49100 && port < 49150, true);
});

test('session verification reads and caches the Android window rect once', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-wizard-rect-test-'));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const calls = [];
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(256, 1)]).toString('base64');
  const helper = new Assistant(root, {http: async (base, endpoint, method, body) => {
    calls.push(endpoint);
    if (endpoint.endsWith('/execute/sync')) return null;
    if (endpoint.endsWith('/source')) return '<hierarchy><android.widget.FrameLayout/></hierarchy>';
    if (endpoint.endsWith('/screenshot')) return png;
    if (endpoint.endsWith('/window/rect')) return {x: 0, y: 0, width: 1080, height: 2400};
    throw new Error('unexpected endpoint ' + endpoint);
  }});
  helper.base = 'http://127.0.0.1:4723';helper.session = 'session-1';
  await helper.verifySession();
  assert.deepEqual(helper.screenRect, {x: 0, y: 0, width: 1080, height: 2400});
  assert.equal(calls.filter(endpoint => endpoint.endsWith('/window/rect')).length, 1);
});


test('verified UiAutomator2 devices use lightweight skip-install capabilities and safely fall back to full verification', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-wizard-fastpath-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const helper=new Assistant(root,{exec:async()=>''});helper.device={serial:'SERIAL-1',model:'Pixel',os:'15',sdk:35,manufacturer:'Google',brand:'google'};
  helper.markTrustedUiAutomator2Provisioning();
  const calls=[];helper.createDeviceSession=async caps=>{calls.push(caps);if(calls.length===1)throw new Error('simulated stale phone component');helper.session='session-ok';};
  helper.verifySession=async()=>{};helper.dropSessionOnly=async()=>{helper.session=null;};
  const baseCaps={platformName:'Android','appium:automationName':'UiAutomator2','appium:udid':'SERIAL-1'};
  await helper.connectAndVerify(baseCaps);
  assert.equal(calls.length,2);assert.equal(calls[0]['appium:skipServerInstallation'],true);assert.equal(calls[0]['appium:skipDeviceInitialization'],true);
  assert.equal(calls[1]['appium:skipServerInstallation'],undefined);assert.equal(helper.trustedUiAutomator2Provisioning(),true);
});

test('command label is cleared after success and attached to failures', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-command-label-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const helper = new Assistant(root, {exec: async (file, args, options) => {
    if (options.label === 'fails') throw new Error('boom');
    return 'ok';
  }});
  assert.equal(await helper.command('/bin/true', [], {label: 'works'}), 'ok');
  assert.equal(helper.currentCommand, null);
  await assert.rejects(helper.command('/bin/false', [], {label: 'fails'}), error => {
    assert.equal(error.commandLabel, 'fails');
    return true;
  });
  assert.equal(helper.currentCommand, null);
});

test('MCP runtime verification loads the pinned ESM SDK exports used by the real stdio server', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-mcp-runtime-'));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const helper = new Assistant(root, {exec: async()=>''}), packageRoot=helper.coreDir, sdkRoot=path.join(packageRoot,'node_modules','@modelcontextprotocol','server');
  fs.mkdirSync(sdkRoot,{recursive:true});fs.writeFileSync(path.join(packageRoot,'package.json'),'{"name":"runtime","private":true,"type":"module"}');
  fs.writeFileSync(path.join(sdkRoot,'package.json'),JSON.stringify({name:'@modelcontextprotocol/server',version:'2.0.0',type:'module',exports:{'.':'./index.js','./stdio':'./stdio.js'}}));
  fs.writeFileSync(path.join(sdkRoot,'index.js'),'export class McpServer{}; export const fromJsonSchema=x=>x;');
  fs.writeFileSync(path.join(sdkRoot,'stdio.js'),'export function serveStdio(){return {close:async()=>{}}}');
  assert.equal(await helper.verifyMcpSdk(),true);
});

test('MCP runtime verification rejects a package that has the right version but missing required API exports', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-mcp-runtime-bad-'));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const helper = new Assistant(root, {exec: async()=>''}), packageRoot=helper.coreDir, sdkRoot=path.join(packageRoot,'node_modules','@modelcontextprotocol','server');
  fs.mkdirSync(sdkRoot,{recursive:true});fs.writeFileSync(path.join(packageRoot,'package.json'),'{"name":"runtime","private":true,"type":"module"}');
  fs.writeFileSync(path.join(sdkRoot,'package.json'),JSON.stringify({name:'@modelcontextprotocol/server',version:'2.0.0',type:'module',exports:{'.':'./index.js','./stdio':'./stdio.js'}}));
  fs.writeFileSync(path.join(sdkRoot,'index.js'),'export class McpServer{};');
  fs.writeFileSync(path.join(sdkRoot,'stdio.js'),'export function serveStdio(){return {close:async()=>{}}}');
  await assert.rejects(()=>helper.verifyMcpSdk(),/MCP Server SDK API 验证失败/);
});


test('browser launch validates localhost page and falls back to AppleScript when open fails', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-browser-open-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const server = http.createServer((_req, res) => {res.writeHead(200, {'Content-Type':'text/html'});res.end('ok');});
  await new Promise((resolve, reject) => {server.once('error', reject);server.listen(0, '127.0.0.1', resolve);});
  t.after(() => new Promise(resolve => server.close(resolve)));
  const token = 'a'.repeat(64);
  const url = `http://127.0.0.1:${server.address().port}/#${token}`;
  assert.equal(parseLocalControlUrl(url).href, url);
  assert.throws(() => parseLocalControlUrl('https://example.com/#' + token), /控制页地址无效/);
  const calls = [];
  const helper = new Assistant(root, {exec: async (file, args, options) => {
    calls.push({file,args,label:options.label});
    if (file === '/usr/bin/open') throw new Error('LaunchServices failed');
    return '';
  }});
  await helper.openControlInBrowser(url);
  assert.equal(calls[0].file, '/usr/bin/open');
  assert.equal(calls[1].file, '/usr/bin/osascript');
  assert.equal(calls[1].args.at(-1), url);
});
