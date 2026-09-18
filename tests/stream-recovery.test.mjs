import test from 'node:test';
import assert from 'node:assert/strict';
import {H264_RETRY_DELAYS_MS, classifyH264Failure, nextH264RetryDelay, retryDelayLabel}
  from '../src/stream-recovery.mjs';

test('H264 failure diagnostics distinguish encoder, transport, timeout, scrcpy and browser decoder failures', () => {
  assert.equal(classifyH264Failure(new Error('手机视频编码器拒绝了当前 H.264 配置。')).category, 'device-encoder');
  assert.equal(classifyH264Failure(new Error('scrcpy 视频 socket 启动失败：ECONNREFUSED')).category, 'transport');
  assert.equal(classifyH264Failure(new Error('在限定时间内没有收到有效 H.264 视频头。')).category, 'timeout');
  assert.equal(classifyH264Failure(new Error('scrcpy 视频进程退出：app_process failed')).category, 'scrcpy');
  assert.equal(classifyH264Failure(new Error('浏览器 H.264 解码失败：VideoDecoder error')).category, 'browser-decoder');
});

test('H264 diagnostics inspect detailed downgrade failures returned by the server', () => {
  const error = new Error('H.264 实时流启动失败。');
  error.details = {failures: [
    {fps: 60, reason: 'scrcpy 视频 socket 启动失败：connection reset'},
    {fps: 45, reason: '手机视频编码器拒绝了当前 H.264 配置。'},
  ]};
  const result = classifyH264Failure(error);
  assert.equal(result.category, 'device-encoder');
  assert.match(result.detail, /60/);
  assert.match(result.detail, /编码器拒绝/);
});

test('background retry uses conservative backoff and caps at fifteen minutes', () => {
  assert.deepEqual(H264_RETRY_DELAYS_MS, [120000, 300000, 600000, 900000]);
  assert.equal(nextH264RetryDelay(0), 120000);
  assert.equal(nextH264RetryDelay(1), 300000);
  assert.equal(nextH264RetryDelay(2), 600000);
  assert.equal(nextH264RetryDelay(99), 900000);
  assert.equal(retryDelayLabel(120000), '2 分钟');
  assert.equal(retryDelayLabel(30000), '30 秒');
});
