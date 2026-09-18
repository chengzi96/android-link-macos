import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Assistant} from '../src/wizard.mjs';
import {startControlServer} from '../src/control.mjs';

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-link-lobby-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return root;
}

test('App launch opens the device lobby without requiring a phone or creating an Appium session', async t => {
  const helper = new Assistant(tempRoot(t));
  const calls = [];
  helper.inspectEnvironment = async () => calls.push('environment');
  helper.assertInstalledRuntime = async () => calls.push('runtime');
  helper.openControl = async options => calls.push(['control', options.waitForTerminal]);
  helper.selectDeviceForApp = async () => { throw new Error('must not select a phone during app launch'); };
  helper.startServer = async () => { throw new Error('must not start Appium during app launch'); };
  await helper.app();
  assert.deepEqual(calls, ['environment', 'runtime', ['control', false]]);
  assert.equal(helper.session, null);
});

test('installation provisioning prepares only Mac runtime and never waits for an Android phone', async t => {
  const helper = new Assistant(tempRoot(t), {prompt: async () => 'n'});
  const calls = [];
  helper.inspectEnvironment = async () => calls.push('environment');
  helper.installPlatformTools = async () => calls.push('adb');
  helper.installScrcpyServer = async () => calls.push('scrcpy');
  helper.installStack = async () => calls.push('stack');
  helper.chooseDevice = async () => { throw new Error('installer must not wait for phone'); };
  helper.verifyAndConnect = async () => { throw new Error('installer must not create phone session'); };
  await helper.provision();
  assert.deepEqual(calls, ['environment', 'adb', 'scrcpy', 'stack']);
});

test('device discovery exposes opaque references, remembers prior phone and caches static device details', async t => {
  const helper = new Assistant(tempRoot(t));
  helper.state.lastDevice = 'SERIAL-SECRET-123';
  let detailCalls = 0;
  helper.listDevices = async () => [
    {serial: 'SERIAL-SECRET-123', state: 'device', model: 'Redmi_K30_Pro'},
    {serial: 'UNAUTHORIZED-456', state: 'unauthorized', model: 'Pixel_8'},
  ];
  helper.deviceDetails = async record => { detailCalls++; return {...record, model: 'Redmi K30 Pro', os: '12', sdk: '31', brand: 'Redmi', manufacturer: 'Xiaomi'}; };
  const first = await helper.discoverDevices();
  const second = await helper.discoverDevices();
  assert.equal(detailCalls, 1);
  assert.equal(first.devices.length, 2);
  assert.equal(first.devices[0].remembered, true);
  assert.match(first.devices[0].ref, /^[a-f0-9]{20}$/);
  assert.equal(JSON.stringify(first).includes('SERIAL-SECRET-123'), false);
  assert.equal(JSON.stringify(first).includes('UNAUTHORIZED-456'), false);
  assert.equal(first.devices[1].state, 'unauthorized');
  assert.equal(second.rememberedRef, first.devices[0].ref);
});

test('explicit device connection uses opaque ref and cancellation invalidates an in-flight generation', async t => {
  const helper = new Assistant(tempRoot(t));
  helper.listDevices = async () => [{serial: 'PHONE-A', state: 'device', model: 'Pixel'}];
  helper.deviceDetails = async record => ({...record, model: 'Pixel', os: '15', sdk: 35, brand: 'Google', manufacturer: 'Google'});
  helper.disconnect = async () => { helper.session = null; helper.base = null; };
  helper.startServer = async () => ({'appium:automationName': 'UiAutomator2'});
  helper.connectAndVerify = async () => { helper.session = 'session-a'; helper.connectedAt = new Date().toISOString(); helper.screenRect = {x:0,y:0,width:1080,height:2400}; };
  const ref = helper.deviceRef('PHONE-A');
  const result = await helper.connectDeviceRef(ref);
  assert.equal(result.model, 'Pixel');
  assert.equal(helper.session, 'session-a');
  assert.equal(helper.state.lastDevice, 'PHONE-A');
  await helper.cancelConnection();
  assert.equal(helper.session, null);
});

test('control HTTP API lists devices and connects a selected opaque device without exposing ADB serials', async t => {
  const fake = {
    session: null, device: null, screenRect: null, connectedAt: null, base: null,
    state: {installationId: 'test-install', uiPreferences: {}}, knownSecrets: [], scrcpyServerPath: '/missing',
    save() {}, deviceRef(serial) { return serial === 'SECRET-SERIAL' ? '0123456789abcdefabcd' : ''; },
    async discoverDevices() { return {devices:[{ref:'0123456789abcdefabcd',state:'device',model:'Pixel 8',os:'15',sdk:'35',brand:'Google',manufacturer:'Google',remembered:false}],rememberedRef:null,selectedRef:null,autoConnect:false}; },
    async connectDeviceRef(ref) { assert.equal(ref, '0123456789abcdefabcd'); this.device={serial:'SECRET-SERIAL',model:'Pixel 8',os:'15'};this.session='session';this.screenRect={x:0,y:0,width:1080,height:2400};this.connectedAt=new Date().toISOString();return{ref,model:'Pixel 8',os:'15',sdk:'35'}; },
    async cancelConnection(){this.session=null;return{cancelled:true};}, async disconnect(){this.session=null;},
    async command(){return '';}
  };
  const server = await startControlServer(fake, {touchStartTimeoutMs: 50});
  t.after(() => server.close());
  const url = new URL(server.url), token = url.hash.slice(1), headers = {'X-AndroidLink-Token': token};
  const devices = await fetch(server.origin + '/api/devices', {headers}).then(r => r.json());
  assert.equal(devices.devices[0].model, 'Pixel 8');
  assert.equal(JSON.stringify(devices).includes('SECRET-SERIAL'), false);
  const connected = await fetch(server.origin + '/api/connect', {method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({deviceRef:'0123456789abcdefabcd'})}).then(r=>r.json());
  assert.equal(connected.connected, true);
  assert.equal(connected.device.model, 'Pixel 8');
});

test('control page includes manual device lobby, auto-connect preference and restrained mono tech typography', () => {
  const base = new URL('../src/', import.meta.url);
  const html = fs.readFileSync(new URL('control.html', base), 'utf8');
  const js = fs.readFileSync(new URL('control.js', base), 'utf8');
  const css = fs.readFileSync(new URL('control.css', base), 'utf8');
  assert.match(html, /id="devicePanel"/);
  assert.match(html, /id="refreshDevices"/);
  assert.match(html, /id="autoConnect"/);
  assert.match(html, /id="cancelConnect"/);
  assert.match(js, /connectDevice\(/);
  assert.match(js, /api\('devices'/);
  assert.match(js, /autoConnect/);
  assert.match(css, /SFMono-Regular/);
  assert.match(css, /\.device-row/);
});
