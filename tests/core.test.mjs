import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOST_COMPAT, compatibleNode, compatibleMacOS, compatibleJavaOutput, parseAdbDevices, normalizeProperties, deviceProblems,
  deviceDiagnostic, capabilities, validSerial, errorCategory,
} from '../src/core.mjs';

test('Node compatibility follows UiAutomator2 v8 engine range', () => {
  assert.equal(compatibleNode('v20.19.0'), true);
  assert.equal(compatibleNode('22.12.1'), true);
  assert.equal(compatibleNode('v24.0.0'), true);
  assert.equal(compatibleNode('v22.11.0'), false);
  assert.equal(compatibleNode('v18.20.0'), false);
});


test('host compatibility targets macOS 12+ on both Apple Silicon and Intel with private Node 22.16.0', () => {
  assert.deepEqual(HOST_COMPAT.architectures, ['arm64', 'x64']);
  assert.equal(HOST_COMPAT.minMacOSMajor, 12);
  assert.equal(HOST_COMPAT.nodeVersion, '22.16.0');
  assert.equal(compatibleMacOS('12.0'), true);
  assert.equal(compatibleMacOS('12.7.6'), true);
  assert.equal(compatibleMacOS('15.6'), true);
  assert.equal(compatibleMacOS('11.7.10'), false);
  assert.equal(compatibleMacOS('unknown'), false);
});

test('Java 17 detector accepts both --version and legacy -version formats', () => {
  assert.equal(compatibleJavaOutput('openjdk 17.0.20.1 2026-08-18\nOpenJDK Runtime Environment Temurin-17.0.20.1+1'), true);
  assert.equal(compatibleJavaOutput('openjdk version "17.0.20.1" 2026-08-18'), true);
  assert.equal(compatibleJavaOutput('openjdk 21.0.2 2024-01-16'), false);
});

test('ADB device list parser preserves state without trusting device text', () => {
  const devices = parseAdbDevices(`List of devices attached
R5CR10ABCD device product:a52 model:SM_A525F device:a52q transport_id:1
192.168.1.5:5555 unauthorized product:foo model:Pixel_8 device:husky transport_id:2
emulator-5554 offline transport_id:3
bad serial device model:Ignored
`);
  assert.deepEqual(devices.map(({serial, state, model}) => ({serial, state, model})), [
    {serial: 'R5CR10ABCD', state: 'device', model: 'SM A525F'},
    {serial: '192.168.1.5:5555', state: 'unauthorized', model: 'Pixel 8'},
    {serial: 'emulator-5554', state: 'offline', model: 'Android'},
  ]);
  assert.equal(validSerial('serial;rm'), false);
});

test('device eligibility requires online Android API 26+', () => {
  const record = {serial: 'ABC-123', state: 'device', model: 'Pixel'};
  const supported = normalizeProperties(record, {sdk: '35', os: '15', manufacturer: 'Google', brand: 'google', model: 'Pixel 9'});
  assert.deepEqual(deviceProblems(supported), []);
  assert.equal(capabilities(supported)['appium:udid'], 'ABC-123');
  assert.equal(capabilities(supported)['appium:autoGrantPermissions'], false);
  assert.match(deviceProblems({...supported, sdk: 25}).join(' '), /Android 8/);
  assert.match(deviceProblems({...supported, state: 'unauthorized'}).join(' '), /USB 调试/);
});

test('Xiaomi family uses the targeted Hidden API compatibility capability', () => {
  const base = {serial: 'ABC-123', state: 'device', sdk: 31, os: '12', model: 'Phone'};
  assert.equal(capabilities({...base, manufacturer: 'Xiaomi', brand: 'Redmi'})['appium:ignoreHiddenApiPolicyError'], true);
  assert.equal(capabilities({...base, manufacturer: 'Google', brand: 'google'})['appium:ignoreHiddenApiPolicyError'], undefined);
});

test('shareable device diagnostic omits the ADB serial', () => {
  const result = deviceDiagnostic({serial: 'SECRET-SERIAL', state: 'device', sdk: 35, os: '15', manufacturer: 'Google', brand: 'google', model: 'Pixel'});
  assert.equal(JSON.stringify(result).includes('SECRET-SERIAL'), false);
  assert.deepEqual(result, {state: 'device', sdk: 35, os: '15', manufacturer: 'Google', brand: 'google', model: 'Pixel'});
});

test('Android-specific failures get stable categories', () => {
  assert.equal(errorCategory('INSTALL_FAILED_USER_RESTRICTED: Install canceled by user'), 'install-restricted');
  assert.equal(errorCategory('device unauthorized. Please check the confirmation dialog'), 'usb-authorization');
  assert.equal(errorCategory('UiAutomator2 instrumentation failed'), 'uiautomator2');
  assert.equal(errorCategory('Permission denial: writing to settings requires:android.permission.WRITE_SECURE_SETTINGS'), 'hidden-api-policy');
});
