export const FAST_REFRESH_MS = 800;
export const IDLE_REFRESH_MS = 2000;
export const FAST_WINDOW_MS = 5000;
export const POST_ACTION_REFRESH_MS = 220;
export const STATUS_CHECK_MS = 15000;

export function adaptiveRefreshDelay(lastActionAt, now = Date.now()) {
  if (!Number.isFinite(lastActionAt) || lastActionAt <= 0) return IDLE_REFRESH_MS;
  return now - lastActionAt < FAST_WINDOW_MS ? FAST_REFRESH_MS : IDLE_REFRESH_MS;
}

export function shouldRefresh({connected, automatic, hidden}) {
  return Boolean(connected && automatic && !hidden);
}
