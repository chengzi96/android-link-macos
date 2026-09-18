import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptiveRefreshDelay, FAST_REFRESH_MS, IDLE_REFRESH_MS, POST_ACTION_REFRESH_MS, shouldRefresh}
  from '../src/refresh-scheduler.mjs';

test('adaptive refresh is fast after control activity and slows down while idle', () => {
  const now = 100000;
  assert.equal(adaptiveRefreshDelay(now - 100, now), FAST_REFRESH_MS);
  assert.equal(adaptiveRefreshDelay(now - 4999, now), FAST_REFRESH_MS);
  assert.equal(adaptiveRefreshDelay(now - 5000, now), IDLE_REFRESH_MS);
  assert.equal(adaptiveRefreshDelay(0, now), IDLE_REFRESH_MS);
  assert.equal(POST_ACTION_REFRESH_MS >= 150 && POST_ACTION_REFRESH_MS <= 300, true);
});

test('refresh scheduler stops when page is hidden or auto refresh is disabled', () => {
  assert.equal(shouldRefresh({connected: true, automatic: true, hidden: false}), true);
  assert.equal(shouldRefresh({connected: true, automatic: true, hidden: true}), false);
  assert.equal(shouldRefresh({connected: true, automatic: false, hidden: false}), false);
  assert.equal(shouldRefresh({connected: false, automatic: true, hidden: false}), false);
});
