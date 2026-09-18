import crypto from 'node:crypto';
import {AutomationError} from './automation-errors.mjs';

const DEFAULT_TTL_MS = 60000;
const MAX_TTL_MS = 300000;

export class ControlLeaseManager {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now());
    this.defaultTtlMs = Math.max(5000, Math.min(MAX_TTL_MS, Number(options.defaultTtlMs) || DEFAULT_TTL_MS));
    this.maxTtlMs = Math.max(this.defaultTtlMs, Math.min(15 * 60_000, Number(options.maxTtlMs) || MAX_TTL_MS));
    this.lease = null;
    this.activeWriter = null;
  }

  current(options = {}) {
    this.#expire();
    if (!this.lease) return {active: false};
    const value = {active: true, owner: this.lease.owner, expiresAt: new Date(this.lease.expiresAt).toISOString()};
    if (options.includeLeaseId) value.leaseId = this.lease.leaseId;
    return value;
  }

  acquire(owner, ttlMs) {
    this.#expire();
    const cleanOwner = String(owner || '').replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!cleanOwner) throw new AutomationError('LEASE_REQUIRED', 'owner 不能为空。');
    const ttl = this.#ttl(ttlMs);
    // owner is only a human-readable label, not an authentication identity. Never
    // hand an existing leaseId to a second caller merely because it reused the same label.
    // The current holder must renew with the actual leaseId.
    if (this.lease) throw new AutomationError('LEASE_CONFLICT', undefined, {retryable: true, details: {owner: this.lease.owner, expiresAt: new Date(this.lease.expiresAt).toISOString()}});
    this.lease = {owner: cleanOwner, leaseId: crypto.randomUUID(), expiresAt: this.now() + ttl};
    return this.current({includeLeaseId: true});
  }

  renew(leaseId, ttlMs) {
    const lease = this.require(leaseId);
    lease.expiresAt = this.now() + this.#ttl(ttlMs);
    return this.current({includeLeaseId: true});
  }

  release(leaseId) {
    this.require(leaseId);
    this.lease = null;
    return {released: true};
  }

  require(leaseId) {
    if (this.lease && this.lease.expiresAt <= this.now()) {this.lease = null; throw new AutomationError('LEASE_EXPIRED', undefined, {retryable: true});}
    if (!this.lease) throw new AutomationError('LEASE_REQUIRED');
    if (typeof leaseId !== 'string' || !leaseId) throw new AutomationError('LEASE_REQUIRED');
    if (leaseId !== this.lease.leaseId) throw new AutomationError('LEASE_CONFLICT', undefined, {retryable: true, details: {owner: this.lease.owner}});
    return this.lease;
  }

  assertHumanCanWrite() {
    this.#expire();
    if (this.activeWriter) throw new AutomationError('LEASE_CONFLICT', 'AI 控制动作仍在执行，请等待本次动作结束后再人工操作。', {retryable: true, details: {owner: this.activeWriter.owner}});
    if (this.lease) throw new AutomationError('LEASE_CONFLICT', 'AI 正在控制手机，请先点击“停止 AI 并接管”。', {retryable: true, details: {owner: this.lease.owner, expiresAt: new Date(this.lease.expiresAt).toISOString()}});
  }

  takeoverByHuman() {
    this.#expire();
    if (this.activeWriter?.kind === 'drag') throw new AutomationError('LEASE_CONFLICT', 'AI 正在执行拖动，请等待手势结束后再接管。', {retryable: true, details: {owner: this.lease?.owner || this.activeWriter.owner || 'AI'}});
    const previous = this.lease ? {owner: this.lease.owner, leaseId: this.lease.leaseId} : null;
    this.lease = null;
    return {takenOver: true, previousOwner: previous?.owner || null};
  }

  async withWriter({kind = 'action', owner = 'unknown', leaseId = null, human = false}, fn) {
    if (this.activeWriter) throw new AutomationError('LEASE_CONFLICT', '已有控制动作正在执行，不会排队。', {retryable: true, details: {owner: this.activeWriter.owner}});
    if (human) this.assertHumanCanWrite(); else this.require(leaseId);
    this.activeWriter = {kind, owner: human ? 'human' : String(owner || 'AI').slice(0, 80), startedAt: this.now()};
    try { return await fn(); }
    finally { this.activeWriter = null; }
  }

  #ttl(value) {
    const requested = Number(value);
    return Math.max(5000, Math.min(this.maxTtlMs, Number.isFinite(requested) ? Math.round(requested) : this.defaultTtlMs));
  }

  #expire() {
    if (this.lease && this.lease.expiresAt <= this.now()) this.lease = null;
  }
}
