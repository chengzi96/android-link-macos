import http from 'node:http';
import {findFreePort} from './video-stream.mjs';

export function normalizeMjpegFps(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 30;
  return Math.max(10, Math.min(60, Math.round(n)));
}

export function mjpegProfile(value = 30) {
  const fps = normalizeMjpegFps(value);
  if (fps >= 50) return {fps: 60, scaling: 45, quality: 45};
  if (fps >= 30) return {fps: 30, scaling: 55, quality: 50};
  return {fps: 20, scaling: 60, quality: 55};
}

export function adaptiveMjpegProfile(requestedFps = 30, observedFps = null) {
  const requested = normalizeMjpegFps(requestedFps), observed = Number(observedFps);
  if (Number.isFinite(observed) && observed > 0) {
    if (observed < 17) return {fps: 20, scaling: 65, quality: 58};
    if (observed < 26) return {fps: 30, scaling: 60, quality: 55};
    if (observed < requested * .65) return {fps: Math.min(30, requested), scaling: 58, quality: 53};
  }
  return mjpegProfile(requested);
}

export class MjpegVideoStream {
  constructor(helper, options = {}) {
    this.helper = helper;this.updateSettings = options.updateSettings || (async () => {});
    this.forwardPort = null;this.request = null;this.response = null;this.stopped = false;
  }
  async start(requestedFps = 30, timeoutMs = 4500, observedFps = null) {
    if (!this.helper.device?.serial || !this.helper.session) throw new Error('手机未连接。');
    this.stopped = false;const profile = adaptiveMjpegProfile(requestedFps, observedFps);
    await this.updateSettings({mjpegServerFramerate: profile.fps, mjpegScalingFactor: profile.scaling,
      mjpegServerScreenshotQuality: profile.quality, mjpegBilinearFiltering: false});
    this.forwardPort = await findFreePort();
    await this.helper.adb(['-s', this.helper.device.serial, 'forward', 'tcp:' + this.forwardPort, 'tcp:7810'], {label: 'mjpeg-forward', timeout: 12000, sensitiveOutput: true});
    try {
      this.response = await new Promise((resolve, reject) => {
        const req = http.get({host: '127.0.0.1', port: this.forwardPort, path: '/', headers: {Connection: 'keep-alive'}}, response => {
          const type = String(response.headers['content-type'] || '');
          if (response.statusCode !== 200 || !/multipart\/x-mixed-replace/i.test(type)) {
            response.resume();reject(new Error('UiAutomator2 MJPEG 服务返回异常：HTTP ' + response.statusCode));return;
          }
          resolve(response);
        });
        this.request = req;
        const timer = setTimeout(() => {req.destroy(new Error('UiAutomator2 MJPEG 连接超时。'));}, timeoutMs);
        req.once('response', () => clearTimeout(timer));req.once('error', error => {clearTimeout(timer);reject(error);});
      });
      return {profile, response: this.response};
    } catch (error) {await this.stop();throw error;}
  }
  async stop() {
    if (this.stopped) return;this.stopped = true;
    try {this.response?.destroy();} catch {}this.response = null;
    try {this.request?.destroy();} catch {}this.request = null;
    if (this.forwardPort && this.helper.device?.serial) {
      try {await this.helper.adb(['-s', this.helper.device.serial, 'forward', '--remove', 'tcp:' + this.forwardPort], {label: 'mjpeg-forward-remove', timeout: 5000, sensitiveOutput: true});} catch {}
    }
    this.forwardPort = null;
  }
}
