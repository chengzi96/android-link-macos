import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {AutomationError, asAutomationError} from './automation-errors.mjs';
import {ControlLeaseManager} from './control-lease.mjs';
import {parseAndroidTree, summarizeTree, treeHash} from './ui-tree.mjs';
import {findElements, uniqueElement} from './selectors.mjs';
import {UnavailableRuntimeSpecProvider} from './runtime-spec-provider.mjs';
import {CheckpointStore, displayPath, hashBuffer, safeName} from './checkpoint.mjs';
import {pngDimensions, semanticScreenshotLabel} from './control.mjs';
import {AUTOMATION_PROTOCOL_VERSION} from './automation-protocol.mjs';
import {VERSION} from './core.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const KEYCODES = Object.freeze({back: 4, home: 3, recent: 187, enter: 66});
const STATUS_BAR_COMMANDS = Object.freeze({notifications: 'expand-notifications', quick_settings: 'expand-settings', collapse: 'collapse'});
const TRANSITION_SUMMARY_TIMEOUT_MS = 1200;
const ARTIFACT_MAX_FILES_PER_KIND = 120;
const ARTIFACT_MAX_BYTES_PER_KIND = 512 * 1024 * 1024;

function abortedError(message = '操作已取消。') { return new AutomationError('ACTION_TIMEOUT', message, {retryable: true}); }
function throwIfAborted(signal, message) { if (signal?.aborted) throw abortedError(message); }

export function normalizeGestureDuration(value, fallback, minimum, maximum) {
  const raw = Number(value);
  const normalized = Number.isFinite(raw) ? Math.round(raw) : Math.round(Number(fallback) || 0);
  return Math.max(Math.round(minimum), Math.min(Math.round(maximum), normalized));
}

function normalizePoint(point) {
  if (!point || typeof point !== 'object') throw new AutomationError('INVALID_SELECTOR', '坐标无效。');
  const x = Number(point.x), y = Number(point.y);
  if (![x,y].every(v => Number.isFinite(v) && v >= 0 && v <= 1)) throw new AutomationError('INVALID_SELECTOR', '相对坐标必须位于 0–1。');
  return {x,y};
}
function centerPoint(bounds, rect) {
  if (!bounds || !rect || bounds.width <= 0 || bounds.height <= 0) throw new AutomationError('ELEMENT_NOT_FOUND', '元素没有可用坐标。');
  return {x: Math.max(0, Math.min(1, (bounds.x + bounds.width / 2) / rect.width)), y: Math.max(0, Math.min(1, (bounds.y + bounds.height / 2) / rect.height))};
}
function absolutePoint(point, rect) {
  const p = normalizePoint(point);
  return {x: Math.min(rect.width - 1, Math.max(0, Math.floor(p.x * rect.width))), y: Math.min(rect.height - 1, Math.max(0, Math.floor(p.y * rect.height)))};
}
function safePackage(value) { return typeof value === 'string' && /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(value) && value.length <= 220 ? value : null; }
function safeActivity(value) { return typeof value === 'string' && /^[A-Za-z0-9_.$/]+$/.test(value) && value.length <= 260 ? value : null; }
function actionSelectorSummary(selector) {
  if (!selector || typeof selector !== 'object') return null;
  return {fields: Object.keys(selector).filter(key => key !== 'text' && key !== 'contentDescription').slice(0, 12)};
}
function sanitizeOwner(value) { return String(value || 'AI').replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'AI'; }
function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new AutomationError('INTERNAL_ERROR', 'AI 工具数据目录不安全。');
  fs.chmodSync(directory, 0o700);
  return directory;
}

export class AutomationService {
  constructor(helper, options = {}) {
    this.helper = helper;
    this.root = helper.root;
    this.protocolVersion = AUTOMATION_PROTOCOL_VERSION;
    this.lease = options.leaseManager || new ControlLeaseManager(options.leaseOptions);
    this.runtimeSpecProvider = options.runtimeSpecProvider || new UnavailableRuntimeSpecProvider();
    this.checkpoints = options.checkpointStore || new CheckpointStore(this.root);
    this.snapshotCache = null;
    this.parsedTree = null;
    this.sourcePromise = null;
    this.sourceController = null;
    this.screenshotPromise = null;
    this.screenshotController = null;
    this.density = null;
    this.auditDir = path.join(this.root, 'ai', 'audit');
    this.artifactDir = path.join(this.root, 'ai', 'artifacts');
    this.lastStableHash = null;
    this.lastStableAt = 0;
    this.hooks = {};
    for (const dir of [path.join(this.root, 'ai'), this.auditDir, this.artifactDir]) ensurePrivateDirectory(dir);
  }

  setHooks(hooks = {}) { this.hooks = {...this.hooks, ...hooks}; }
  leaseState() { return this.lease.current(); }
  humanTakeover() { const result = this.lease.takeoverByHuman(); this.#audit('human_takeover', {previousOwner: result.previousOwner}); return result; }

  async dispatch(method, params = {}, context = {}) {
    try {
      switch (method) {
        case 'status': return this.status();
        case 'observe': return this.observe(params, context);
        case 'find_elements': return this.findElements(params, context);
        case 'get_runtime_spec': return this.getRuntimeSpec();
        case 'acquire_control': return this.acquireControl(params);
        case 'renew_control': return this.renewControl(params);
        case 'release_control': return this.releaseControl(params);
        case 'tap': return this.tap(params, context);
        case 'swipe': return this.swipe(params, context);
        case 'drag': return this.drag(params, context);
        case 'input_text': return this.inputText(params, context);
        case 'press_key': return this.pressKey(params, context);
        case 'status_bar': return this.statusBar(params, context);
        case 'launch_app': return this.launchApp(params, context);
        case 'wait_for': return this.waitFor(params, context.signal);
        case 'checkpoint': return this.checkpoint(params, context);
        case 'disconnect': return this.disconnect(params, context);
        default: throw new AutomationError('INTERNAL_ERROR', `不支持的 AutomationService 方法：${method}`);
      }
    } catch (error) { throw asAutomationError(error); }
  }

  async status() {
    const app = await this.#currentApp().catch(() => ({packageName: null, activity: null}));
    const rect = this.helper.screenRect || null;
    return {
      assistantVersion: VERSION,
      protocolVersion: this.protocolVersion,
      connected: Boolean(this.helper.session),
      device: this.helper.device ? {model: this.helper.device.model || 'Android', androidVersion: this.helper.device.os || null,
        orientation: rect ? (rect.width > rect.height ? 'landscape' : 'portrait') : null, viewportPx: rect ? {width: rect.width, height: rect.height} : null} : null,
      app,
      controlLease: this.lease.current(),
    };
  }

  acquireControl(params = {}) {
    this.#requireSession();
    const result = this.lease.acquire(sanitizeOwner(params.owner), params.ttlMs);
    this.#audit('lease_acquire', {owner: result.owner, expiresAt: result.expiresAt});
    return result;
  }
  renewControl(params = {}) { const result = this.lease.renew(params.leaseId, params.ttlMs); this.#audit('lease_renew', {owner: result.owner, expiresAt: result.expiresAt}); return result; }
  releaseControl(params = {}) { const current = this.lease.current(); const result = this.lease.release(params.leaseId); this.#audit('lease_release', {owner: current.owner || null}); return result; }

  async observe(params = {}, context = {}) {
    this.#requireSession();
    const treeLevel = ['none','summary','full_file'].includes(params.tree) ? params.tree : 'summary';
    const wantScreenshot = Boolean(params.screenshot);
    const wantRuntime = Boolean(params.runtimeSpec);
    const [source, png, app, rect, density] = await Promise.all([
      treeLevel === 'none' ? Promise.resolve(null) : this.#source(false,{signal:context.signal}),
      wantScreenshot ? this.#screenshot(false,{signal:context.signal}) : Promise.resolve(null),
      this.#currentApp(context.signal).catch(() => ({packageName: null, activity: null})),
      this.#rect(context.signal),
      this.#density().catch(() => null),
    ]);
    let parsed = null, elements = [], hash = this.parsedTree?.hash || null, stable = false, xmlPath = null;
    if (source != null) {
      parsed = parseAndroidTree(source); this.parsedTree = parsed; hash = parsed.hash;
      const now = Date.now(); stable = this.lastStableHash === hash && now - this.lastStableAt >= 250;
      if (this.lastStableHash !== hash) {this.lastStableHash = hash; this.lastStableAt = now;} else if (!this.lastStableAt) this.lastStableAt = now;
      elements = treeLevel === 'summary' || treeLevel === 'full_file' ? summarizeTree(parsed) : [];
      if (treeLevel === 'full_file') xmlPath = this.#writeArtifact('xml', Buffer.from(source), '.xml');
    }
    let screenshot = null;
    if (png) {
      const dims = pngDimensions(png), saved = this.#writeArtifact('screenshots', png, '.png');
      screenshot = {path: saved.path, sha256: saved.sha256, width: dims.width, height: dims.height, capturedAt: new Date().toISOString()};
    }
    let runtimeSpec = null, runtimeSpecError = null;
    if (wantRuntime) {
      try { runtimeSpec = await this.runtimeSpecProvider.getRuntimeSpec({helper: this.helper, source, parsed}); }
      catch (error) { if (error?.code === 'RUNTIME_SPEC_UNAVAILABLE') runtimeSpecError = {code: error.code, message: error.message}; else throw error; }
    }
    const snapshot = {
      snapshotVersion: 1,
      capturedAt: new Date().toISOString(),
      device: {model: this.helper.device?.model || 'Android', androidVersion: this.helper.device?.os || null,
        orientation: rect.width > rect.height ? 'landscape' : 'portrait', viewportPx: {width: rect.width, height: rect.height}, density},
      app,
      screen: {screenId: runtimeSpec?.screenId || null, treeHash: hash, stable},
      elements,
      screenshot,
      ...(treeLevel === 'full_file' ? {pageXml: {path: xmlPath.path, sha256: xmlPath.sha256}} : {}),
      runtimeSpec,
      ...(runtimeSpecError ? {runtimeSpecError} : {}),
    };
    this.snapshotCache = {at: Date.now(), snapshot, parsed};
    return snapshot;
  }

  async findElements(params = {}, context = {}) {
    this.#requireSession();
    const parsed = await this.#treeForSelector(context.signal);
    const matches = findElements(parsed, params.selector || params).map(element => this.#publicElement(element));
    const selector = params.selector || params;
    if (matches.length > 1 && selector.index == null) throw new AutomationError('AMBIGUOUS_ELEMENT', undefined, {details: {count: matches.length}});
    return {treeHash: parsed.hash, elements: matches};
  }

  async getRuntimeSpec() {
    this.#requireSession();
    return this.runtimeSpecProvider.getRuntimeSpec({helper: this.helper, parsed: this.parsedTree});
  }

  async tap(params = {}, context = {}) {
    return this.#writeAction('tap', params, context, async () => {
      const rect = await this.#rect(context.signal);
      const point = params.selector ? centerPoint((await this.#element(params.selector,context.signal)).boundsPx, rect) : normalizePoint(params.point || params);
      const absolute = absolutePoint(point, rect);
      await this.#call('/execute/sync','POST',{script:'mobile: clickGesture', args:[absolute]},12000,context.signal);
      return {point};
    });
  }

  async swipe(params = {}, context = {}) {
    return this.#writeAction('swipe', params, context, async () => {
      const direction = String(params.direction || ''); if (!['up','down','left','right'].includes(direction)) throw new AutomationError('INVALID_SELECTOR','滑动方向无效。');
      const ratio = Math.max(.1, Math.min(.85, Number(params.distanceRatio) || .5));
      const duration = normalizeGestureDuration(params.durationMs, 320, 150, 1500);
      const half = ratio / 2;
      const from = {x:.5,y:.5}, to = {x:.5,y:.5};
      if (direction === 'up') {from.y=.5+half;to.y=.5-half;} if (direction === 'down') {from.y=.5-half;to.y=.5+half;}
      if (direction === 'left') {from.x=.5+half;to.x=.5-half;} if (direction === 'right') {from.x=.5-half;to.x=.5+half;}
      await this.#w3cDrag(from,to,duration,context.signal); return {direction,distanceRatio:ratio,durationMs:duration};
    });
  }

  async drag(params = {}, context = {}) {
    return this.#writeAction('drag', params, context, async () => {
      const rect = await this.#rect(context.signal);
      let from = params.from ? normalizePoint(params.from) : null, to = params.to ? normalizePoint(params.to) : null;
      if (params.fromSelector) from = centerPoint((await this.#element(params.fromSelector,context.signal)).boundsPx, rect);
      if (params.toSelector) to = centerPoint((await this.#element(params.toSelector,context.signal)).boundsPx, rect);
      if (!from || !to) throw new AutomationError('INVALID_SELECTOR','drag 需要起点和终点。');
      const duration = normalizeGestureDuration(params.durationMs, 350, 180, 3000);
      await this.#w3cDrag(from,to,duration,context.signal); return {from,to,durationMs:duration};
    });
  }

  async inputText(params = {}, context = {}) {
    if (typeof params.text !== 'string' || !params.text || params.text.length > 2000) throw new AutomationError('INVALID_SELECTOR','输入内容长度必须为 1–2000。');
    const length = params.text.length;
    return this.#writeAction('input_text', {...params, text: undefined}, context, async () => {
      if (params.selector) {
        const rect = await this.#rect(context.signal), element = await this.#element(params.selector,context.signal), absolute = absolutePoint(centerPoint(element.boundsPx, rect), rect);
        await this.#call('/execute/sync','POST',{script:'mobile: clickGesture', args:[absolute]},12000,context.signal);
      }
      const active = await this.#call('/element/active','GET',undefined,8000,context.signal);
      const id = active?.['element-6066-11e4-a52e-4f735466cecf'] || active?.ELEMENT;
      if (!id) throw new AutomationError('ELEMENT_NOT_FOUND','没有可输入的当前焦点元素。');
      if (this.helper.knownSecrets && !this.helper.knownSecrets.includes(params.text)) this.helper.knownSecrets.push(params.text);
      await this.#call('/element/' + encodeURIComponent(id) + '/value','POST',{text:params.text},12000,context.signal);
      return {characters:length};
    }, {auditExtra:{characters:length}});
  }

  async pressKey(params = {}, context = {}) {
    const key = String(params.key || ''); if (!(key in KEYCODES)) throw new AutomationError('INVALID_SELECTOR','只允许 back、home、recent、enter。');
    return this.#writeAction('press_key', params, context, async () => {
      await this.#call('/execute/sync','POST',{script:'mobile: pressKey',args:[{keycode:KEYCODES[key]}]},12000,context.signal); return {key};
    });
  }

  async statusBar(params = {}, context = {}) {
    const action = String(params.action || '');
    const command = STATUS_BAR_COMMANDS[action];
    if (!command) throw new AutomationError('INVALID_SELECTOR','系统面板只允许 notifications、quick_settings、collapse。');
    return this.#writeAction('status_bar', params, context, async () => {
      const serial = this.helper.device?.serial;
      if (!serial || typeof this.helper.adb !== 'function') throw new AutomationError('SESSION_NOT_READY','当前没有可用的 Android ADB 控制通道。',{retryable:true});
      await this.helper.adb(['-s', serial, 'shell', 'cmd', 'statusbar', command], {label:'ai-statusbar-' + action,timeout:8000,sensitiveOutput:true});
      return {action};
    }, {auditExtra:{action}});
  }

  async launchApp(params = {}, context = {}) {
    const packageName = safePackage(params.packageName); if (!packageName) throw new AutomationError('INVALID_SELECTOR','应用包名无效。');
    const activity = params.activity == null ? null : safeActivity(params.activity); if (params.activity != null && !activity) throw new AutomationError('INVALID_SELECTOR','Activity 无效。');
    const deepLink = params.deepLink == null ? null : String(params.deepLink);
    if (deepLink && (deepLink.length > 2000 || !/^[a-z][a-z0-9+.-]*:/i.test(deepLink))) throw new AutomationError('INVALID_SELECTOR','deep link 无效。');
    return this.#writeAction('launch_app', {leaseId:params.leaseId, owner:params.owner, packageName, activity: activity || undefined, deepLink: deepLink ? '[provided]' : undefined}, context, async () => {
      const installed = await this.#call('/execute/sync','POST',{script:'mobile: queryAppState',args:[{appId:packageName}]},10000,context.signal).catch(error=>{throwIfAborted(context.signal);return 0;});
      if (Number(installed) === 0) throw new AutomationError('APP_NOT_INSTALLED');
      if (deepLink) await this.#call('/execute/sync','POST',{script:'mobile: deepLink',args:[{url:deepLink,package:packageName}]},15000,context.signal);
      else if (activity) await this.#call('/execute/sync','POST',{script:'mobile: startActivity',args:[{intent:`${packageName}/${activity}`}]},15000,context.signal);
      else await this.#call('/execute/sync','POST',{script:'mobile: activateApp',args:[{appId:packageName}]},15000,context.signal);
      return {packageName, activity: activity || null, deepLink: Boolean(deepLink)};
    });
  }

  async waitFor(params = {}, signal) {
    this.#requireSession();
    const timeoutMs = Math.max(250, Math.min(120000, Number(params.timeoutMs || params.timeout) || 15000));
    const pollMs = Math.max(120, Math.min(2000, Number(params.pollMs) || 300));
    const started = Date.now(); let sameHashSince = null, sameHash = null;
    while (Date.now() - started <= timeoutMs) {
      if (signal?.aborted) throw new AutomationError('WAIT_TIMEOUT','等待已取消。',{retryable:true});
      if (params.selector) {
        const parsed = parseAndroidTree(await this.#source(true,{signal,timeoutMs:Math.min(5000,Math.max(500,timeoutMs-(Date.now()-started)))})); this.parsedTree = parsed;
        const matches = findElements(parsed, params.selector);
        const state = params.state || 'visible';
        const ok = state === 'gone' || state === 'hidden' ? !matches.some(e => e.visible) : state === 'present' ? matches.length > 0 : matches.some(e => e.visible);
        if (ok) return {matched:true,state,elapsedMs:Date.now()-started,elements:matches.slice(0,5).map(e=>this.#publicElement(e))};
      } else if (params.text) {
        const source = await this.#source(true,{signal,timeoutMs:Math.min(5000,Math.max(500,timeoutMs-(Date.now()-started)))}); if (String(source).includes(String(params.text))) return {matched:true,state:'text',elapsedMs:Date.now()-started};
      } else if (params.packageName || params.activity) {
        const app = await this.#currentApp(signal); if ((!params.packageName || app.packageName===params.packageName) && (!params.activity || app.activity===params.activity)) return {matched:true,state:'app',elapsedMs:Date.now()-started,app};
      } else if (params.screenId) {
        const spec = await this.getRuntimeSpec(); if (spec?.screenId === params.screenId) return {matched:true,state:'screenId',elapsedMs:Date.now()-started,screenId:spec.screenId};
      } else if (params.uiStable) {
        const hash = treeHash(await this.#source(true,{signal,timeoutMs:Math.min(5000,Math.max(500,timeoutMs-(Date.now()-started)))})); const now = Date.now();
        if (hash !== sameHash) {sameHash = hash; sameHashSince = now;} else if (now - sameHashSince >= Math.max(300, Math.min(5000, Number(params.stableMs) || 700))) return {matched:true,state:'ui_stable',elapsedMs:now-started,treeHash:hash};
      } else throw new AutomationError('INVALID_SELECTOR','wait_for 缺少等待条件。');
      await sleep(pollMs);
    }
    throw new AutomationError('WAIT_TIMEOUT',undefined,{retryable:true,details:{timeoutMs}});
  }

  async checkpoint(params = {}, context = {}) {
    this.#requireSession();
    const [source,png,app,rect] = await Promise.all([this.#source(true,{signal:context.signal}),this.#screenshot(true,{signal:context.signal}),this.#currentApp(context.signal).catch(()=>({packageName:null,activity:null})),this.#rect(context.signal)]);
    const parsed = parseAndroidTree(source); this.parsedTree = parsed;
    let runtimeSpec = null; try {runtimeSpec = await this.runtimeSpecProvider.getRuntimeSpec({helper:this.helper,source,parsed});} catch (error) {if (error?.code !== 'RUNTIME_SPEC_UNAVAILABLE') throw error;}
    const dims = pngDimensions(png);
    const snapshot = {snapshotVersion:1,capturedAt:new Date().toISOString(),device:{model:this.helper.device?.model||'Android',androidVersion:this.helper.device?.os||null,
      orientation:rect.width>rect.height?'landscape':'portrait',viewportPx:{width:rect.width,height:rect.height},density:await this.#density().catch(()=>null)},app,
      screen:{screenId:runtimeSpec?.screenId||null,treeHash:parsed.hash,stable:false},elements:summarizeTree(parsed),screenshot:{file:'screen.png',sha256:hashBuffer(png),width:dims.width,height:dims.height},runtimeSpec};
    const name = safeName(params.name || semanticScreenshotLabel(source) || '检查点');
    const saved = this.checkpoints.save({name,png,xml:source,snapshot,runtimeSpec,metadata:{assistantVersion:VERSION,protocolVersion:this.protocolVersion}});
    this.#audit('checkpoint',{name}); return saved;
  }

  async disconnect(params = {}, context = {}) {
    return this.#writeAction('disconnect', params, context, async () => { await this.hooks.beforeDisconnect?.(); await this.helper.disconnect(); this.invalidate(); await this.hooks.afterDisconnect?.(); return {connected:false}; });
  }

  async humanAction(method, params = {}) {
    const map = {tap:'tap',swipe:'swipe',drag:'drag',input:'input_text',back:'press_key',home:'press_key',recent:'press_key',notifications:'status_bar','quick-settings':'status_bar','collapse-panel':'status_bar'};
    const target = map[method] || method;
    const next = ['back','home','recent'].includes(method) ? {key:method} : method === 'notifications' ? {action:'notifications'} : method === 'quick-settings' ? {action:'quick_settings'} : method === 'collapse-panel' ? {action:'collapse'} : params;
    return this.dispatch(target,next,{human:true,owner:'human',includeTransition:false});
  }

  invalidate() { this.snapshotCache = null; this.parsedTree = null; }

  async #writeAction(name, params, context, fn, options = {}) {
    this.#requireSession(); const started = Date.now(); const owner = context.human ? 'human' : sanitizeOwner(params.owner || context.owner || 'AI');
    return this.lease.withWriter({kind:name==='drag'?'drag':'action',owner,leaseId:params.leaseId,human:Boolean(context.human)},async()=>{
      throwIfAborted(context.signal);
      this.#cancelBackgroundReads();
      const before = !context.human && context.includeTransition !== false ? this.#cachedPageSummary() : null;
      const result = await fn();
      this.invalidate();
      let after = null;
      if (!context.human && context.includeTransition !== false && !context.signal?.aborted) {
        await sleep(120);
        after = await this.#pageSummary({signal:context.signal,timeoutMs:TRANSITION_SUMMARY_TIMEOUT_MS}).catch(()=>null);
      }
      const elapsedMs = Date.now()-started;
      this.#audit(name,{owner:context.human?'human':owner,selector:actionSelectorSummary(params.selector||params.fromSelector),elapsedMs,...options.auditExtra});
      return {...result,durationMs:elapsedMs,...(!context.human?{before,after}:{})};
    });
  }

  #cachedPageSummary() {
    const parsed=this.parsedTree || this.snapshotCache?.parsed;
    if(!parsed) return null;
    const app=this.snapshotCache?.snapshot?.app || {packageName:null,activity:null};
    return {treeHash:parsed.hash,app,elements:summarizeTree(parsed,{maxElements:20})};
  }

  async #pageSummary(options={}) {
    const source = await this.#source(true,{signal:options.signal,timeoutMs:options.timeoutMs||TRANSITION_SUMMARY_TIMEOUT_MS}), parsed = parseAndroidTree(source); this.parsedTree=parsed;
    const app = await this.#currentApp(options.signal,Math.min(1200,options.timeoutMs||TRANSITION_SUMMARY_TIMEOUT_MS)).catch(()=>({packageName:null,activity:null}));
    return {treeHash:parsed.hash,app,elements:summarizeTree(parsed,{maxElements:20})};
  }

  async #element(selector, signal) { return uniqueElement(await this.#treeForSelector(signal), selector); }
  async #treeForSelector(signal) {
    if (this.parsedTree && this.snapshotCache && Date.now()-this.snapshotCache.at < 500) return this.parsedTree;
    const parsed = parseAndroidTree(await this.#source(true,{signal})); this.parsedTree=parsed; return parsed;
  }
  #publicElement(element) { return {elementRef:element.elementRef,qaId:element.qaId,resourceId:element.resourceId,text:element.text,contentDescription:element.contentDescription,
    className:element.className,boundsPx:element.boundsPx,visible:element.visible,clickable:element.clickable,enabled:element.enabled}; }
  #requireSession() { if (!this.helper.session) throw new AutomationError('DEVICE_NOT_CONNECTED',undefined,{retryable:true}); }
  async #call(route, method='GET', body, timeout=15000, signal) {
    this.#requireSession();
    throwIfAborted(signal);
    try { return await this.helper.http(this.helper.base,'/session/'+encodeURIComponent(this.helper.session)+route,method,body,timeout,signal); }
    catch (error) {
      if (signal?.aborted) throw abortedError(signal.reason === 'control-priority' ? '后台观察已被控制动作抢占，请重试。' : '操作已取消或超时。');
      if (/invalid session id|NoSuchDriver|session.*(?:terminated|not known)/i.test(String(error?.message||error))) throw new AutomationError('DEVICE_NOT_CONNECTED',undefined,{retryable:true});
      throw error;
    }
  }
  #cancelBackgroundReads() {
    for (const controller of [this.sourceController,this.screenshotController]) if (controller && !controller.signal.aborted) controller.abort('control-priority');
    this.sourcePromise=null;this.sourceController=null;this.screenshotPromise=null;this.screenshotController=null;
  }
  async #source(force=false, options={}) {
    if (!force && this.snapshotCache?.parsed?.xml && Date.now()-this.snapshotCache.at < 350) return this.snapshotCache.parsed.xml;
    if (this.sourcePromise) return this.sourcePromise;
    const controller=new AbortController();
    const signal=options.signal ? AbortSignal.any([controller.signal,options.signal]) : controller.signal;
    const timeout=Math.max(250,Math.min(12000,Number(options.timeoutMs)||12000));
    const promise=this.#call('/source','GET',undefined,timeout,signal).finally(()=>{if(this.sourcePromise===promise){this.sourcePromise=null;this.sourceController=null;}});
    this.sourcePromise=promise;this.sourceController=controller;return promise;
  }
  async #screenshot(force=false, options={}) {
    if (this.screenshotPromise) return this.screenshotPromise;
    const controller=new AbortController();
    const signal=options.signal ? AbortSignal.any([controller.signal,options.signal]) : controller.signal;
    const timeout=Math.max(500,Math.min(30000,Number(options.timeoutMs)||30000));
    const promise=(async()=>{const image=await this.#call('/screenshot','GET',undefined,timeout,signal);const png=Buffer.from(String(image||''),'base64');pngDimensions(png);return png;})()
      .finally(()=>{if(this.screenshotPromise===promise){this.screenshotPromise=null;this.screenshotController=null;}});
    this.screenshotPromise=promise;this.screenshotController=controller;return promise;
  }
  async #rect(signal) {
    if (this.helper.screenRect && this.helper.screenRect.width>0 && this.helper.screenRect.height>0) return this.helper.screenRect;
    const rect=await this.#call('/window/rect','GET',undefined,8000,signal);this.helper.screenRect={x:Number(rect.x)||0,y:Number(rect.y)||0,width:Math.floor(rect.width),height:Math.floor(rect.height)};return this.helper.screenRect;
  }
  async #currentApp(signal, timeout=6000) {
    const [packageName,activity]=await Promise.all([
      this.#call('/appium/device/current_package','GET',undefined,timeout,signal).catch(error=>{throwIfAborted(signal);return null;}),
      this.#call('/appium/device/current_activity','GET',undefined,timeout,signal).catch(error=>{throwIfAborted(signal);return null;}),
    ]);
    return {packageName:typeof packageName==='string'?packageName:null,activity:typeof activity==='string'?activity:null};
  }
  async #density() {
    if (this.density) return this.density;
    if (!this.helper.adbPath || !this.helper.device?.serial) return null;
    const output=await this.helper.command(this.helper.adbPath,['-s',this.helper.device.serial,'shell','wm','density'],{label:'ai-read-density',timeout:5000,sensitiveOutput:true});
    const values=[...String(output).matchAll(/(?:Override|Physical)?\s*density:\s*(\d+)/gi)].map(m=>Number(m[1])).filter(n=>n>=72&&n<=1000);
    const dpi=values.at(-1);this.density=dpi?Number((dpi/160).toFixed(2)):null;return this.density;
  }
  async #w3cDrag(from,to,duration,signal) {
    const rect=await this.#rect(signal),a=absolutePoint(from,rect),b=absolutePoint(to,rect);
    // UiAutomator2 deserializes W3C action duration as a Java long. Browser pointer timing is often fractional,
    // so enforce an integer again at the final protocol boundary even if an upstream caller forgot to normalize it.
    const durationMs=normalizeGestureDuration(duration,350,1,3000);
    const body={actions:[{type:'pointer',id:'androidlink-ai-finger',parameters:{pointerType:'touch'},actions:[{type:'pointerMove',duration:0,x:a.x,y:a.y,origin:'viewport'},{type:'pointerDown',button:0},{type:'pointerMove',duration:durationMs,x:b.x,y:b.y,origin:'viewport'},{type:'pause',duration:80},{type:'pointerUp',button:0}]}]};
    try {await this.#call('/actions','POST',body,Math.max(12000,durationMs+5000),signal);} finally {await this.#call('/actions','DELETE',undefined,4000).catch(()=>{});}
  }
  #writeArtifact(kind, data, extension) {
    const dir=ensurePrivateDirectory(path.join(this.artifactDir,kind));
    const file=path.join(dir,`${Date.now()}-${crypto.randomUUID()}${extension}`);fs.writeFileSync(file,data,{flag:'wx',mode:0o600});this.#pruneArtifacts(dir,file);return {path:displayPath(file),sha256:hashBuffer(Buffer.isBuffer(data)?data:Buffer.from(data))};
  }
  #pruneArtifacts(dir, keepFile) {
    try {
      const files=fs.readdirSync(dir).map(name=>path.join(dir,name)).filter(file=>{try{const info=fs.lstatSync(file);return info.isFile()&&!info.isSymbolicLink();}catch{return false;}})
        .map(file=>({file,info:fs.lstatSync(file)})).sort((a,b)=>b.info.mtimeMs-a.info.mtimeMs);
      let bytes=0,count=0;
      for(const entry of files){count++;bytes+=entry.info.size;if(entry.file===keepFile)continue;if(count>ARTIFACT_MAX_FILES_PER_KIND||bytes>ARTIFACT_MAX_BYTES_PER_KIND){try{fs.unlinkSync(entry.file);}catch{}}}
    } catch {}
  }
  #audit(action, fields={}) {
    try {
      ensurePrivateDirectory(this.auditDir);const day=new Date().toISOString().slice(0,10),file=path.join(this.auditDir,`${day}.jsonl`);
      if (fs.existsSync(file)) {const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink())return;}
      const record={at:new Date().toISOString(),action,...fields};
      const clean=JSON.parse(JSON.stringify(record,(key,value)=>/text|secret|token|serial|xml|source|password/i.test(key)?undefined:typeof value==='string'?value.replace(/\/Users\/[^/\s"']+/g,'/Users/[用户]').slice(0,240):value));
      fs.appendFileSync(file,JSON.stringify(clean)+'\n',{mode:0o600});fs.chmodSync(file,0o600);
    } catch {}
  }
}
