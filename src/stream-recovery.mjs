export const H264_RETRY_DELAYS_MS = Object.freeze([120000, 300000, 600000, 900000]);

function collectFailureText(value) {
  const parts = [];
  const visit = item => {
    if (!item) return;
    if (typeof item === 'string') {parts.push(item);return;}
    if (item instanceof Error) {if (item.message) parts.push(item.message);if (item.details) visit(item.details);return;}
    if (Array.isArray(item)) {for (const entry of item) visit(entry);return;}
    if (typeof item === 'object') {
      if (typeof item.error === 'string') parts.push(item.error);
      if (typeof item.reason === 'string') parts.push(`${Number.isFinite(Number(item.fps)) ? Number(item.fps) + 'fps: ' : ''}${item.reason}`);
      if (typeof item.runtimeError === 'string') parts.push(item.runtimeError);
      if (typeof item.failure === 'string') parts.push(item.failure);
      if (item.failures) visit(item.failures);
    }
  };
  visit(value);
  return parts.join(' · ').replace(/\s+/g, ' ').trim();
}

export function classifyH264Failure(value) {
  const raw = collectFailureText(value) || '未返回更具体的错误信息。';
  const lower = raw.toLowerCase();
  let category = 'unknown', label = '未知兼容问题';
  if (/webcodecs|videodecoder|encodedvideochunk|浏览器.*解码|h\.264 解码/.test(lower)) {
    category = 'browser-decoder'; label = '浏览器 H.264 解码失败';
  } else if (/mediacodec|omx|编码器|encoder|video_codec|codec.*配置|configure.*codec|拒绝了当前 h\.264 配置/.test(lower)) {
    category = 'device-encoder'; label = '手机 H.264 编码器配置失败';
  } else if (/socket|econn|connection reset|broken pipe|端口|forward|连接实时视频流/.test(lower)) {
    category = 'transport'; label = 'ADB / 视频通道连接失败';
  } else if (/超时|timeout|timed out|限定时间|首帧|没有收到有效 h\.264 视频头/.test(lower)) {
    category = 'timeout'; label = 'H.264 启动或首帧超时';
  } else if (/scrcpy.*进程|app_process|scrcpy.*server|scrcpy-push|classnotfound|jar/.test(lower)) {
    category = 'scrcpy'; label = 'scrcpy 手机端启动失败';
  } else if (/视频流已结束|视频流已断开|stream.*ended|stream.*closed|已关闭/.test(lower)) {
    category = 'interrupted'; label = 'H.264 视频流中断';
  }
  return {category, label, detail: raw.slice(0, 360)};
}

export function nextH264RetryDelay(failureCount = 0) {
  const n = Number.isFinite(Number(failureCount)) ? Math.max(0, Math.floor(Number(failureCount))) : 0;
  return H264_RETRY_DELAYS_MS[Math.min(n, H264_RETRY_DELAYS_MS.length - 1)];
}

export function retryDelayLabel(ms) {
  const seconds = Math.max(1, Math.round(Number(ms) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes} 分钟`;
}
