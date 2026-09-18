import crypto from 'node:crypto';
import {AutomationError, publicError} from './automation-errors.mjs';

export const AUTOMATION_PROTOCOL_VERSION = 1;
export const IPC_MAX_REQUEST_BYTES = 256 * 1024;
export const IPC_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const IPC_DEFAULT_TIMEOUTS = Object.freeze({read: 15000, action: 20000, wait: 120000});

export function validRequestId(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
}

export function makeRequest(method, params = {}, auth) {
  return {protocolVersion: AUTOMATION_PROTOCOL_VERSION, requestId: crypto.randomUUID(), method, params, ...(auth ? {auth} : {})};
}

export function validateRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AutomationError('INTERNAL_ERROR', 'IPC 请求格式无效。');
  if (value.protocolVersion !== AUTOMATION_PROTOCOL_VERSION) throw new AutomationError('PROTOCOL_VERSION_UNSUPPORTED', undefined, {details: {supported: AUTOMATION_PROTOCOL_VERSION}});
  if (!validRequestId(value.requestId)) throw new AutomationError('INTERNAL_ERROR', 'requestId 格式无效。');
  if (typeof value.method !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(value.method)) throw new AutomationError('INTERNAL_ERROR', 'method 格式无效。');
  if (value.params != null && (typeof value.params !== 'object' || Array.isArray(value.params))) throw new AutomationError('INTERNAL_ERROR', 'params 必须是对象。');
  return {protocolVersion: value.protocolVersion, requestId: value.requestId, method: value.method, params: value.params || {}, auth: value.auth};
}

export function successResponse(requestId, result) {
  return {protocolVersion: AUTOMATION_PROTOCOL_VERSION, requestId, ok: true, result};
}

export function failureResponse(requestId, error) {
  return {protocolVersion: AUTOMATION_PROTOCOL_VERSION, requestId: validRequestId(requestId) ? requestId : 'invalid-request', ok: false, error: publicError(error)};
}

export function encodeMessage(value, maxBytes = IPC_MAX_RESPONSE_BYTES) {
  const json = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(json) > maxBytes) throw new AutomationError('INTERNAL_ERROR', 'IPC 响应过大。');
  return json;
}
