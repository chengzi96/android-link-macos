import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createInterface} from 'node:readline/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {
  VERSION, HOST_COMPAT, PACKAGES, SCRCPY_SERVER, PLATFORM_TOOLS, JDK, compatibleNode, compatibleMacOS, compatibleJavaOutput, parseAdbDevices,
  normalizeProperties, deviceProblems, deviceDiagnostic, capabilities,
  assertAppiumResponse, errorHint, errorCategory, errorEvidence, redact,
  readJson, writeJson, safeChild,
} from './core.mjs';
import {startControlServer} from './control.mjs';
import {AutomationService} from './automation-service.mjs';
import {AutomationIpcServer} from './ipc-server.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
class Paused extends Error {}

export function parseLocalControlUrl(value) {
  const url = new URL(String(value));
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
      url.pathname !== '/' || url.search || !/^[a-f0-9]{64}$/.test(url.hash.slice(1))) {
    throw new Error('控制页地址无效。');
  }
  return url;
}

export async function httpJson(base, endpoint, method = 'GET', body, timeout = 30000, externalSignal) {
  const origin = new URL(base), target = new URL(endpoint, origin);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.username || origin.password ||
      target.origin !== origin.origin || target.username || target.password) throw new Error('拒绝连接非本机 Appium 服务。');
  const timeoutSignal = AbortSignal.timeout(timeout);
  const signal = externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;
  const response = await fetch(target, {method, headers: body ? {'Content-Type': 'application/json'} : {},
    body: body ? JSON.stringify(body) : undefined, signal, redirect: 'error'});
  let json;
  try { json = await response.json(); } catch { throw new Error('Appium 返回了无法读取的内容。'); }
  return assertAppiumResponse(json, response.status);
}

export async function freePort(start) {
  for (let port = start; port < start + 50; port++) {
    const free = await new Promise(resolve => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error('所需本机端口均被占用；助手不会终止其他应用。');
}

export class Assistant {
  constructor(root, options = {}) {
    this.root = root;
    this.env = {...process.env};
    for (const key of Object.keys(this.env)) if (/^(?:APPIUM_|ANDROID_|npm_config_)/i.test(key)) delete this.env[key];
    delete this.env.NODE_OPTIONS; delete this.env.NODE_PATH; delete this.env.JAVA_HOME;
    this.coreDir = path.join(root, 'stack', 'server');
    this.extensionDir = path.join(root, 'stack', 'extensions');
    this.sdkDir = path.join(root, 'android-sdk');
    this.platformToolsDir = path.join(this.sdkDir, 'platform-tools');
    this.adbPath = path.join(this.platformToolsDir, 'adb');
    this.streamDir = path.join(root, 'stream');
    this.scrcpyServerPath = path.join(this.streamDir, 'scrcpy-server-v' + SCRCPY_SERVER.version);
    this.jdkDir = path.join(root, 'runtime', 'jdk-' + JDK.version + '-darwin-' + process.arch);
    this.javaHome = path.join(this.jdkDir, 'Contents', 'Home');
    this.javaPath = path.join(this.javaHome, 'bin', 'java');
    this.appium = path.join(this.coreDir, 'node_modules', 'appium', 'index.js');
    this.npm = path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    this.stateFile = path.join(root, 'config', 'state.json');
    this.state = readJson(this.stateFile, {installationId: crypto.randomBytes(8).toString('hex')});
    this.runtimeKey = `node-${HOST_COMPAT.nodeVersion}-${process.arch}`;
    if (this.state.stackReady && this.state.stackRuntime !== this.runtimeKey) this.state.stackReady = false;
    this.env.APPIUM_HOME = this.extensionDir;
    this.env.ANDROID_HOME = this.sdkDir;
    this.env.ANDROID_SDK_ROOT = this.sdkDir;
    this.env.npm_config_registry = 'https://registry.npmjs.org/';
    this.env.npm_config_cache = path.join(root, 'downloads', 'npm');
    this.env.npm_config_userconfig = path.join(root, 'config', 'npmrc');
    this.env.npm_config_globalconfig = path.join(root, 'config', 'npmrc-global');
    this.env.npm_config_engine_strict = 'true'; this.env.npm_config_strict_ssl = 'true';
    this.env.npm_config_fetch_retries = '1'; this.env.npm_config_fetch_timeout = '120000';
    this.refreshRuntimeEnv();
    this.logDir = path.join(root, 'logs', new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid);
    this.execOverride = options.exec; this.promptOverride = options.prompt; this.http = options.http || httpJson;
    this.deviceWaitTimeoutMs = options.deviceWaitTimeoutMs ?? 300000;
    this.connectionWaitTimeoutMs = options.connectionWaitTimeoutMs ?? 600000;
    this.pollIntervalMs = options.pollIntervalMs ?? 3000;
    this.children = new Set(); this.server = null; this.session = null; this.control = null; this.automation = null; this.ipc = null; this.screenRect = null; this.connectionGeneration = 0; this.deviceDiscoveryCache = new Map();
    this.knownSecrets = [os.homedir()]; this.actionLog = [];
    for (const dir of [root, this.logDir, path.join(root, 'config'), path.join(root, 'stack'), path.join(root, 'runtime'),
      path.join(root, 'downloads'), path.join(root, 'backups'), this.streamDir]) fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    for (const file of [this.env.npm_config_userconfig, this.env.npm_config_globalconfig]) {
      if (!fs.existsSync(file)) fs.writeFileSync(file, '', {flag: 'wx', mode: 0o600});
    }
  }

  refreshRuntimeEnv() {
    if (fs.existsSync(this.javaPath)) this.env.JAVA_HOME = this.javaHome;
    this.env.PATH = [this.platformToolsDir, path.join(this.javaHome, 'bin'), path.dirname(process.execPath),
      '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  }
  save() { writeJson(this.stateFile, this.state); }
  out(message) { console.log(String(message).replace(/\x1b\][^\x07]*(?:\x07|$)/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')); }
  section(message) { this.currentStep = message; this.out('\n── ' + message + ' ──'); }
  async ask(message) {
    if (this.promptOverride) return this.promptOverride(message);
    const rl = createInterface({input: process.stdin, output: process.stdout});
    try {
      const answer = (await rl.question(message)).trim();
      if (answer.toLowerCase() === 'q') throw new Paused('已暂停，下次打开可以继续。');
      return answer;
    } finally { rl.close(); }
  }
  mark(stage, value) {
    this.actionLog.push({time: new Date().toISOString(), stage, value});
    writeJson(path.join(this.logDir, 'steps.json'), this.actionLog);
  }
  async command(file, args, options = {}) {
    const label = options.label || path.basename(file); this.currentCommand = label;
    try {
      if (this.execOverride) return await this.execOverride(file, args, options);
      const logPath = path.join(this.logDir, (options.logName || label.replace(/[^a-zA-Z0-9_-]/g, '_')) + '.log');
      const sink = fs.createWriteStream(logPath, {flags: 'a', mode: 0o600});
      const limit = options.timeout || 60000;
      return await new Promise((resolve, reject) => {
        const child = spawn(file, args, {cwd: options.cwd || rootSafe(this.root), env: {...this.env, ...options.env},
          shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
        this.children.add(child);
        let stdout = '', combined = '', pending = '', timedOut = false, settled = false, hardTimer;
        const write = data => {
          combined = (combined + data.toString()).slice(-2_000_000);
          if (options.sensitiveOutput) return;
          pending += data.toString(); const last = pending.lastIndexOf('\n');
          if (last >= 0) {sink.write(redact(pending.slice(0, last + 1), this.knownSecrets));pending = pending.slice(last + 1);}
        };
        child.stdout.setEncoding('utf8').on('data', d => {stdout = (stdout + d).slice(-8_000_000);write(d);});
        child.stderr.setEncoding('utf8').on('data', write);
        const tick = options.progress ? setInterval(() => this.out('仍在处理：' + label + '。可按 Control+C 取消。'), 15000) : null;
        const timer = setTimeout(() => {timedOut = true;this.terminateChild(child);hardTimer = setTimeout(() => this.terminateChild(child, 'SIGKILL'), 3000);}, limit);
        const finish = (error, code) => {
          if (settled) return; settled = true; clearInterval(tick); clearTimeout(timer); clearTimeout(hardTimer);
          this.children.delete(child); sink.end(redact(pending, this.knownSecrets));
          if (error || code !== 0 || timedOut) {
            const failure = new Error((timedOut ? label + ' 超时\n' : '') + (combined || error?.message || '命令失败'));
            failure.code = code ?? error?.code; failure.log = logPath; reject(failure);
          } else resolve(stdout);
        };
        child.once('error', error => finish(error, null)); child.once('close', code => finish(null, code));
      });
    } catch (error) {
      if (error && typeof error === 'object' && !error.commandLabel) error.commandLabel = label;
      throw error;
    } finally {
      if (this.currentCommand === label) this.currentCommand = null;
    }
  }
  terminateChild(child, signal = 'SIGTERM') {
    if (!child || (!this.children.has(child) && this.server !== child) || !child.pid || child.exitCode !== null || child.signalCode) return;
    try { process.kill(-child.pid, signal); } catch {}
  }
  runAppium(args, options) { return this.command(process.execPath, [this.appium, ...args], options); }
  async adb(args, options = {}) { return this.command(this.adbPath, args, {label: 'adb', timeout: 35000, ...options}); }

  async inspectEnvironment() {
    this.section('检查 Mac 环境');
    if (process.platform !== 'darwin') throw new Paused('当前发行包仅支持 macOS。');
    const macOSVersion = (await this.command('/usr/bin/sw_vers', ['-productVersion'], {label: 'macos-version', timeout: 5000})).trim();
    if (!compatibleMacOS(macOSVersion)) throw new Paused(`当前系统为 macOS ${macOSVersion || '未识别'}；本版本要求 macOS ${HOST_COMPAT.minMacOSMajor}.0 及以上。`);
    if (!compatibleNode(process.version) || process.version !== 'v' + HOST_COMPAT.nodeVersion) throw new Paused('专用 Node.js 版本不兼容，请重新运行安装包。');
    if (!HOST_COMPAT.architectures.includes(process.arch)) throw new Paused('暂不支持这种 Mac 芯片架构。');
    this.hostMacOSVersion = macOSVersion;
    const stat = fs.statfsSync(this.root), freeGB = Number(stat.bavail) * Number(stat.bsize) / 1024 ** 3;
    this.out('macOS ' + macOSVersion + ' / ' + process.arch + ' / Node ' + process.version + ' / 可用空间约 ' + freeGB.toFixed(1) + ' GB');
    if (freeGB < 2) throw new Paused('可用空间不足 2 GB，请先释放空间。');
    this.mark('environment', {platform: process.platform, macOS: macOSVersion, architecture: process.arch, node: process.version, freeGB: Number(freeGB.toFixed(1))});
  }

  async verifiedDownload(url, sha256, target, label, timeout = 900000) {
    if (!/^https:\/\/(?:dl\.google\.com|github\.com)\//.test(url) || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('下载源或校验值无效。');
    await this.command('/usr/bin/curl', ['--fail', '--location', '--proto', '=https', '--proto-redir', '=https', '--tlsv1.2',
      '--connect-timeout', '20', '--max-time', String(Math.floor(timeout / 1000)), '--retry', '2', '--retry-all-errors', '--progress-bar', url, '-o', target],
      {label, timeout: timeout + 30000, progress: true});
    const digest = await new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256'), input = fs.createReadStream(target);
      input.on('data', chunk => hash.update(chunk)); input.once('error', reject); input.once('end', () => resolve(hash.digest('hex')));
    });
    if (digest !== sha256) throw new Error(label + ' SHA-256 校验失败，未运行下载内容。');
  }

  async installPlatformTools() {
    this.section('准备 Android 连接工具');
    if (fs.existsSync(this.adbPath)) {
      const version = await this.adb(['version'], {label: 'adb-version'});
      if (version.includes('Version ' + PLATFORM_TOOLS.version)) {this.out('Android Platform-Tools ' + PLATFORM_TOOLS.version + ' 已就绪。');return;}
      throw new Paused('专用目录存在其他版本 Platform-Tools，未自动覆盖。请导出诊断。');
    }
    if (fs.existsSync(this.platformToolsDir)) throw new Paused('发现未完成的 Platform-Tools 目录，未自动删除。请导出诊断。');
    this.out('正在从 Google 官方下载 Android Platform-Tools ' + PLATFORM_TOOLS.version + '，校验 SHA-256 后才使用。');
    const stage = fs.mkdtempSync(path.join(this.root, 'downloads', 'platform-tools-'));
    const archive = path.join(stage, 'platform-tools.zip');
    try {
      await this.verifiedDownload(PLATFORM_TOOLS.url, PLATFORM_TOOLS.sha256, archive, 'download-platform-tools');
      await this.command('/usr/bin/ditto', ['-x', '-k', archive, stage], {label: 'extract-platform-tools', timeout: 120000});
      const extracted = path.join(stage, 'platform-tools');
      if (!fs.existsSync(path.join(extracted, 'adb')) || !fs.readFileSync(path.join(extracted, 'source.properties'), 'utf8').includes('Pkg.Revision=' + PLATFORM_TOOLS.version)) {
        throw new Error('Platform-Tools 压缩包内容不符合预期。');
      }
      fs.mkdirSync(this.sdkDir, {recursive: true, mode: 0o700});
      fs.renameSync(extracted, this.platformToolsDir); fs.chmodSync(this.adbPath, 0o700);
    } finally { try {fs.rmSync(safeChild(this.root, stage), {recursive: true});} catch {} }
    this.refreshRuntimeEnv();
    const version = await this.adb(['version'], {label: 'adb-version'});
    if (!version.includes('Version ' + PLATFORM_TOOLS.version)) throw new Error('ADB 安装后版本验证失败。');
    this.mark('platform-tools', {version: PLATFORM_TOOLS.version, sha256: PLATFORM_TOOLS.sha256});
  }

  async installScrcpyServer() {
    const expected = SCRCPY_SERVER.sha256;
    if (fs.existsSync(this.scrcpyServerPath)) {
      const info = fs.lstatSync(this.scrcpyServerPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== SCRCPY_SERVER.size) throw new Paused('专用 scrcpy 实时流组件异常，请选择“重新安装专用依赖”。');
      const actual = crypto.createHash('sha256').update(fs.readFileSync(this.scrcpyServerPath)).digest('hex');
      if (actual === expected) {this.out('scrcpy 实时流组件 ' + SCRCPY_SERVER.version + ' 已就绪。');return;}
      throw new Paused('scrcpy 实时流组件校验失败，未自动覆盖。请选择“重新安装专用依赖”。');
    }
    this.out('正在从 scrcpy 官方 GitHub 下载实时流组件 ' + SCRCPY_SERVER.version + '，校验 SHA-256 后才使用。');
    const stage = fs.mkdtempSync(path.join(this.root, 'downloads', 'scrcpy-'));
    const target = path.join(stage, 'scrcpy-server');
    try {
      await this.verifiedDownload(SCRCPY_SERVER.url, expected, target, 'download-scrcpy-server', 180000);
      if (fs.statSync(target).size !== SCRCPY_SERVER.size) throw new Error('scrcpy 实时流组件大小与官方发布信息不一致。');
      fs.renameSync(target, this.scrcpyServerPath);fs.chmodSync(this.scrcpyServerPath, 0o600);
    } finally {try {fs.rmSync(safeChild(this.root, stage), {recursive: true});} catch {}}
    this.mark('scrcpy-server', {version: SCRCPY_SERVER.version, sha256: SCRCPY_SERVER.sha256});
  }

  async listDevices() {
    const output = await this.adb(['devices', '-l'], {label: 'adb-devices', timeout: 35000});
    return parseAdbDevices(output);
  }
  async deviceDetails(record) {
    if (!record || record.state !== 'device') return normalizeProperties(record, {});
    const get = async name => (await this.adb(['-s', record.serial, 'shell', 'getprop', name], {label: 'adb-getprop', sensitiveOutput: true})).trim();
    const [sdk, osVersion, manufacturer, brand, model] = await Promise.all([
      get('ro.build.version.sdk'), get('ro.build.version.release'), get('ro.product.manufacturer'),
      get('ro.product.brand'), get('ro.product.model'),
    ]);
    return normalizeProperties(record, {sdk, os: osVersion, manufacturer, brand, model});
  }
  deviceRef(serial) {
    if (typeof serial !== 'string' || !serial) return '';
    const installationId = String(this.state.installationId || 'android-link');
    return crypto.createHash('sha256').update(installationId + ':' + serial).digest('hex').slice(0, 20);
  }
  async discoverDevices() {
    const records = await this.listDevices();
    const devices = [];
    for (const record of records) {
      let detail = normalizeProperties(record, {});
      if (record.state === 'device') {
        const cached = this.deviceDiscoveryCache.get(record.serial);
        if (cached) detail = cached;
        else {detail = await this.deviceDetails(record).catch(() => normalizeProperties(record, {}));this.deviceDiscoveryCache.set(record.serial, detail);}
      }
      const ref = this.deviceRef(record.serial);
      devices.push({ref, state: record.state, model: detail.model || record.model || 'Android 设备', os: detail.os || '', sdk: detail.sdk || '',
        manufacturer: detail.manufacturer || '', brand: detail.brand || '', remembered: Boolean(this.state.lastDevice && record.serial === this.state.lastDevice)});
    }
    const rememberedRef = this.state.lastDevice ? this.deviceRef(this.state.lastDevice) : null;
    const selected = this.session && this.device?.serial ? this.deviceRef(this.device.serial) : null;
    if (this.state.detectedDeviceCount !== records.length) {this.state.detectedDeviceCount = records.length;this.save();}
    return {devices, rememberedRef, selectedRef: selected, autoConnect: Boolean(this.state.uiPreferences?.autoConnect)};
  }
  async connectDeviceRef(ref) {
    if (typeof ref !== 'string' || !/^[a-f0-9]{20}$/.test(ref)) throw new Error('设备引用无效，请刷新设备列表。');
    const generation = ++this.connectionGeneration;
    const ensureCurrent = () => {if (generation !== this.connectionGeneration) throw new Paused('连接已取消。');};
    const records = await this.listDevices();ensureCurrent();
    const record = records.find(item => this.deviceRef(item.serial) === ref);
    if (!record) throw new Error('这台 Android 手机当前未连接，请刷新设备列表。');
    this.knownSecrets.push(record.serial);
    if (record.state !== 'device') throw new Error(deviceProblems(normalizeProperties(record, {})).join('\n') || '手机尚未准备好。');
    const device = await this.deviceDetails(record), problems = deviceProblems(device);ensureCurrent();
    this.recordObservation(device, records.length);
    if (problems.length) throw new Error(problems.join('\n'));
    await this.disconnect();ensureCurrent();
    this.device = device;this.state.lastDevice = device.serial;this.save();
    const caps = await this.startServer();ensureCurrent();
    try {await this.connectAndVerify(caps, {pressHome: false});ensureCurrent();}
    catch (error) {if (generation !== this.connectionGeneration) throw new Paused('连接已取消。');throw error;}
    return {ref: this.deviceRef(device.serial), model: device.model, os: device.os || '', sdk: device.sdk || ''};
  }
  async cancelConnection() {
    this.connectionGeneration++;
    await this.disconnect();
    return {cancelled: true};
  }
  recordObservation(device, count) {
    this.state.detectedDeviceCount = count;
    this.state.deviceObservation = device ? {checkedAt: new Date().toISOString(), ...deviceDiagnostic(device)} : null;
    this.save();
  }
  async chooseDevice() {
    this.section('选择 Android 手机');
    this.out('请用数据线连接手机，开启“开发者选项 → USB 调试”并保持解锁。手机出现“允许 USB 调试”时请本人核对后允许。');
    const started = Date.now(); let lastNotice = 0, records = [], selected = null;
    while (Date.now() - started < this.deviceWaitTimeoutMs) {
      try { records = await this.listDevices(); } catch { records = []; }
      const remembered = this.state.lastDevice ? records.find(item => item.serial === this.state.lastDevice) : null;
      if (remembered) selected = remembered;
      else if (!this.state.lastDevice && records.length === 1) selected = records[0];
      else if (!this.state.lastDevice && records.length > 1) break;
      this.recordObservation(selected ? await this.deviceDetails(selected).catch(() => normalizeProperties(selected, {})) : null, records.length);
      if (selected?.state === 'device') break;
      if (Date.now() - lastNotice > 15000) {
        if (selected?.state === 'unauthorized') this.out('已看到手机，正等待你在手机上允许 USB 调试。');
        else if (selected?.state === 'offline') this.out('手机处于 ADB 离线状态；请重新插线、解锁并重新允许 USB 调试。');
        else if (this.state.lastDevice) this.out('正在等待上次明确选择的手机；不会自动切换到其他设备。');
        else this.out('仍在等待 Android 手机：请连接数据线、解锁并允许 USB 调试。');
        lastNotice = Date.now();
      }
      await sleep(Math.max(100, this.pollIntervalMs));
    }
    if (!selected && records.length > 1 && !this.state.lastDevice) {
      this.out('检测到多台 Android 设备，请明确选择：');
      records.forEach((item, index) => this.out(`${index + 1}. ${item.model} / ${item.state} / …${item.serial.slice(-6)}`));
      const choice = await this.ask('请选择自己要操作的手机编号：');
      if (!/^\d+$/.test(choice) || !records[Number(choice) - 1]) throw new Paused('设备编号无效。');
      selected = records[Number(choice) - 1];
    }
    if (!selected) throw new Paused('5 分钟内仍没有识别到 Android 手机。请检查数据线、USB 用途和开发者选项。');
    this.knownSecrets.push(selected.serial);
    if (selected.state !== 'device') throw new Paused(deviceProblems(normalizeProperties(selected, {})).join('\n'));
    const device = await this.deviceDetails(selected), problems = deviceProblems(device);
    this.recordObservation(device, records.length);
    if (problems.length) throw new Paused(problems.join('\n'));
    this.device = device; this.state.lastDevice = device.serial; this.save();
    this.out('已选择：' + device.model + '（Android ' + (device.os || '未识别') + ' / API ' + device.sdk + '）');
    if (/(?:xiaomi|redmi|poco)/i.test(device.manufacturer + ' ' + device.brand)) this.out('小米/Redmi/POCO 如阻止组件安装，可在开发者选项开启“USB 调试（安全设置）”和“通过 USB 安装”。');
    this.mark('device', deviceDiagnostic(device)); return device;
  }

  installedVersion(pkg, base = this.extensionDir) { return readJson(path.join(base, 'node_modules', pkg, 'package.json'), {})?.version; }
  async verifyMcpSdk() {
    const runtimePackage = path.join(this.coreDir, 'package.json');
    try {
      const resolver = createRequire(runtimePackage);
      const [sdk,stdio] = await Promise.all([
        import(pathToFileURL(resolver.resolve('@modelcontextprotocol/server')).href),
        import(pathToFileURL(resolver.resolve('@modelcontextprotocol/server/stdio')).href),
      ]);
      if (typeof sdk.McpServer !== 'function' || typeof sdk.fromJsonSchema !== 'function' || typeof stdio.serveStdio !== 'function') throw new Error('required exports missing');
      return true;
    } catch (error) { throw new Error('MCP Server SDK API 验证失败，请重新安装专用依赖。'); }
  }
  async installJdk() {
    if (fs.existsSync(this.javaPath)) {
      const output = await this.command(this.javaPath, ['--version'], {label: 'java-version'}).catch(error => error.message);
      if (compatibleJavaOutput(output)) {this.refreshRuntimeEnv();return;}
      throw new Paused('专用 Java 目录版本异常，未自动覆盖。请导出诊断。');
    }
    if (fs.existsSync(this.jdkDir)) throw new Paused('发现未完成的 Java 目录，未自动删除。请导出诊断。');
    const artifact = JDK[process.arch];
    if (!artifact) throw new Paused('没有适合当前 Mac 芯片的 Java 运行环境。');
    this.out('正在下载 Eclipse Temurin JDK 17 专用运行环境（约 180 MB），不会修改系统 Java。');
    const stage = fs.mkdtempSync(path.join(this.root, 'downloads', 'jdk-')), archive = path.join(stage, 'jdk.tar.gz');
    try {
      await this.verifiedDownload(artifact.url, artifact.sha256, archive, 'download-jdk', 1200000);
      await this.command('/usr/bin/tar', ['-xzf', archive, '-C', stage], {label: 'extract-jdk', timeout: 300000});
      const extracted = fs.readdirSync(stage, {withFileTypes: true}).filter(item => item.isDirectory())
        .map(item => path.join(stage, item.name)).find(item => fs.existsSync(path.join(item, 'Contents', 'Home', 'bin', 'java')));
      if (!extracted) throw new Error('JDK 压缩包结构不符合预期。');
      fs.renameSync(extracted, this.jdkDir);
    } finally { try {fs.rmSync(safeChild(this.root, stage), {recursive: true});} catch {} }
    this.refreshRuntimeEnv();
    const version = await this.command(this.javaPath, ['--version'], {label: 'java-version'}).catch(error => {throw new Error(error.message);});
    if (!compatibleJavaOutput(version)) throw new Error('Java 安装后版本验证失败。');
    this.mark('jdk', {version: JDK.version, architecture: process.arch, sha256: artifact.sha256});
  }

  async installStack() {
    this.section('安装专用自动化组件');
    await this.installJdk();
    const coreOK = this.installedVersion('appium', this.coreDir) === PACKAGES.appium && fs.existsSync(this.appium);
    const driverOK = this.installedVersion('appium-uiautomator2-driver') === PACKAGES.uiautomator2;
    const inspectorOK = this.installedVersion('appium-inspector-plugin') === PACKAGES.inspector;
    const mcpOK = this.installedVersion('@modelcontextprotocol/server', this.coreDir) === PACKAGES.mcpServer;
    if (!(coreOK && driverOK && inspectorOK && mcpOK && this.state.stackReady)) {
      this.out(`专用版本：Appium ${PACKAGES.appium} / UiAutomator2 ${PACKAGES.uiautomator2} / Inspector ${PACKAGES.inspector} / MCP Server SDK ${PACKAGES.mcpServer}`);
      this.out('依赖从 npm 官方仓库安装到本工具私有目录，不修改系统 Node/npm/Appium。');
      fs.mkdirSync(this.coreDir, {recursive: true, mode: 0o700}); fs.mkdirSync(this.extensionDir, {recursive: true, mode: 0o700});
      if (!fs.existsSync(path.join(this.coreDir, 'package.json'))) writeJson(path.join(this.coreDir, 'package.json'), {name: 'android-link-local-runtime', private: true, version: VERSION});
      if (!coreOK) await this.command(process.execPath, [this.npm, 'install', '--prefix', this.coreDir, '--registry=https://registry.npmjs.org/',
        '--engine-strict', '--save-exact', '--no-audit', '--no-fund', 'appium@' + PACKAGES.appium], {label: 'install-appium', timeout: 900000, progress: true});
      if (!mcpOK) await this.command(process.execPath, [this.npm, 'install', '--prefix', this.coreDir, '--registry=https://registry.npmjs.org/',
        '--engine-strict', '--save-exact', '--no-audit', '--no-fund', '@modelcontextprotocol/server@' + PACKAGES.mcpServer], {label: 'install-mcp-sdk', timeout: 900000, progress: true});
      if (!driverOK) {
        const current = this.installedVersion('appium-uiautomator2-driver');
        if (current) throw new Paused('专用目录已有其他版本 UiAutomator2 Driver，未自动覆盖。请导出诊断。');
        await this.runAppium(['driver', 'install', '--source=npm', 'appium-uiautomator2-driver@' + PACKAGES.uiautomator2],
          {label: 'install-uiautomator2', timeout: 900000, progress: true});
      }
      if (!inspectorOK) {
        const current = this.installedVersion('appium-inspector-plugin');
        if (current) throw new Paused('专用目录已有其他版本 Inspector，未自动覆盖。请导出诊断。');
        await this.runAppium(['plugin', 'install', '--source=npm', 'appium-inspector-plugin@' + PACKAGES.inspector],
          {label: 'install-inspector', timeout: 900000, progress: true});
      }
    }
    const drivers = JSON.parse(await this.runAppium(['driver', 'list', '--installed', '--json'], {label: 'driver-list'}));
    const plugins = JSON.parse(await this.runAppium(['plugin', 'list', '--installed', '--json'], {label: 'plugin-list'}));
    if (drivers.uiautomator2?.version !== PACKAGES.uiautomator2 || drivers.uiautomator2?.installed === false ||
        plugins.inspector?.version !== PACKAGES.inspector || plugins.inspector?.installed === false) throw new Error('依赖文件存在，但 Appium 注册清单不完整或版本不匹配。');
    if (this.installedVersion('@modelcontextprotocol/server', this.coreDir) !== PACKAGES.mcpServer) throw new Error('MCP Server SDK 版本不匹配。');
    await this.verifyMcpSdk();
    this.state.stackReady = true; this.state.stackRuntime = this.runtimeKey; this.save(); this.mark('stack', {...PACKAGES, runtime: this.runtimeKey});
  }

  async startServer() {
    const port = await freePort(4723), config = path.join(this.root, 'config', 'server.json');
    writeJson(config, {server: {address: '127.0.0.1', port, 'use-drivers': ['uiautomator2'], 'use-plugins': ['inspector'],
      'allow-insecure': ['*:session_discovery'], 'log-level': 'info', 'log-no-colors': true}});
    this.base = 'http://127.0.0.1:' + port;
    this.out('只在本机 127.0.0.1 启动 Appium，未开放局域网控制。');
    const sink = fs.createWriteStream(path.join(this.logDir, 'appium.log'), {mode: 0o600});
    const child = spawn(process.execPath, [this.appium, '--config', config], {cwd: this.root, env: this.env, shell: false,
      detached: true, stdio: ['ignore', 'pipe', 'pipe']});
    this.server = child; this.serverTail = ''; let tail = '', pending = '', spawnError;
    const log = data => {tail = (tail + data).slice(-120000);this.serverTail = (this.serverTail + data).slice(-120000);pending += data.toString();const last = pending.lastIndexOf('\n');
      if (last >= 0) {sink.write(redact(pending.slice(0, last + 1), this.knownSecrets));pending = pending.slice(last + 1);}};
    child.stdout.setEncoding('utf8').on('data', log); child.stderr.setEncoding('utf8').on('data', log);
    child.once('error', error => {spawnError = error;}); child.once('close', () => sink.end(redact(pending, this.knownSecrets)));
    let healthy = false;
    for (let index = 0; index < 60; index++) {
      if (spawnError || child.exitCode !== null || child.signalCode) throw new Error(spawnError?.message || tail || 'Appium 启动失败。');
      try {
        if ((await this.http(this.base, '/status', 'GET', undefined, 1500))?.ready) {
          const owner = await this.command('/usr/sbin/lsof', ['-nP', '-a', '-p', String(child.pid), '-iTCP:' + port, '-sTCP:LISTEN', '-t'],
            {label: 'verify-server-owner', timeout: 5000});
          if (owner.trim().split(/\s+/).includes(String(child.pid))) {healthy = true;break;}
        }
      } catch {}
      await sleep(500);
    }
    if (!healthy) throw new Error('Appium 启动超时。\n' + tail);
    const caps = capabilities(this.device); writeJson(path.join(this.root, 'config', 'Inspector能力.json'), caps); return caps;
  }
  deviceRuntimeKey() {
    if (!this.device?.serial) return null;
    return crypto.createHash('sha256').update(String(this.device.serial)).digest('hex').slice(0, 24);
  }
  trustedUiAutomator2Provisioning() {
    const key = this.deviceRuntimeKey(), record = key ? this.state?.deviceRuntime?.[key] : null;
    return Boolean(record && record.uiautomator2 === PACKAGES.uiautomator2 && record.verified === true);
  }
  markTrustedUiAutomator2Provisioning() {
    const key = this.deviceRuntimeKey();if (!key) return;
    this.state.deviceRuntime = {...(this.state.deviceRuntime || {}), [key]: {uiautomator2: PACKAGES.uiautomator2, verified: true, verifiedAt: new Date().toISOString()}};
    this.save();
  }
  clearTrustedUiAutomator2Provisioning() {
    const key = this.deviceRuntimeKey();if (!key || !this.state?.deviceRuntime?.[key]) return;
    const next = {...this.state.deviceRuntime};delete next[key];this.state.deviceRuntime = next;this.save();
  }
  async dropSessionOnly() {
    const session = this.session;this.session = null;this.screenRect = null;
    if (session && this.base) await this.http(this.base, '/session/' + encodeURIComponent(session), 'DELETE', undefined, 20000).catch(() => {});
    const active = path.join(this.root, 'config', 'active-session.json');try {fs.rmSync(active, {force: true});} catch {}
  }
  async createDeviceSession(caps) {
    const started = Date.now(); let shown = '';
    for (;;) {
      try {
        const session = await this.http(this.base, '/session', 'POST', {capabilities: {alwaysMatch: caps, firstMatch: [{}]}}, 240000);
        if (!session?.sessionId) throw new Error('Appium 未返回 sessionId。');
        this.session = session.sessionId; this.connectedAt = new Date().toISOString(); this.state.pendingAction = null; this.save();
        writeJson(path.join(this.root, 'config', 'active-session.json'), {sessionId: this.session, base: this.base,
          connectedAt: this.connectedAt, device: this.device.serial}); return;
      } catch (error) {
        const raw = error.message + '\n' + (this.serverTail || ''), category = errorCategory(raw);
        if (!['usb-authorization', 'install-restricted', 'device-offline'].includes(category)) throw error;
        this.state.pendingAction = category; this.save();
        if (shown !== category) {this.out(errorHint(raw));shown = category;}
        if (Date.now() - started > this.connectionWaitTimeoutMs) throw new Error(errorHint(raw) + '\n' + errorEvidence(raw).join('\n'));
        await sleep(Math.max(500, this.pollIntervalMs * 3));
      }
    }
  }
  async verifySession(options = {}) {
    const endpoint = '/session/' + encodeURIComponent(this.session);
    const pressHome = options.pressHome !== false;
    if (pressHome) {
      await this.http(this.base, endpoint + '/execute/sync', 'POST', {script: 'mobile: pressKey', args: [{keycode: 3}]}, 45000);
      await sleep(800);
    }
    const source = await this.http(this.base, endpoint + '/source', 'GET', undefined, 45000);
    if (typeof source !== 'string' || !/(?:<hierarchy|<android\.)/i.test(source)) throw new Error('会话存在，但读取 Android 页面结构失败。');
    const screenshot = await this.http(this.base, endpoint + '/screenshot', 'GET', undefined, 45000);
    const png = typeof screenshot === 'string' ? Buffer.from(screenshot, 'base64') : Buffer.alloc(0);
    if (png.length < 100 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('会话存在，但 Android 截图验证失败。');
    const rect = await this.http(this.base, endpoint + '/window/rect', 'GET', undefined, 15000);
    if (!rect || ![rect.width, rect.height].every(value => Number.isFinite(value) && value > 0)) throw new Error('会话存在，但读取 Android 屏幕尺寸失败。');
    this.screenRect = {x: Number.isFinite(rect.x) ? rect.x : 0, y: Number.isFinite(rect.y) ? rect.y : 0, width: Math.floor(rect.width), height: Math.floor(rect.height)};
    this.mark('device-verification', {session: true, home: pressHome, source: true, screenshot: true, screenRect: true});
  }
  async connectAndVerify(caps, options = {}) {
    if (this.trustedUiAutomator2Provisioning()) {
      const fastCaps = {...caps, 'appium:skipServerInstallation': true, 'appium:skipDeviceInitialization': true};
      try {
        this.out('已验证过这台手机的 UiAutomator2 组件，优先走轻量快速连接。');
        await this.createDeviceSession(fastCaps);await this.verifySession(options);this.markTrustedUiAutomator2Provisioning();
        this.mark('uiautomator2-provisioning', {strategy: 'verified-fast-path', verified: true});return;
      } catch (error) {
        this.out('快速连接未通过验证，自动回退完整初始化并修复手机端组件。');
        this.mark('uiautomator2-provisioning', {strategy: 'fast-path-fallback', error: String(error?.message || error).slice(0, 240)});
        this.clearTrustedUiAutomator2Provisioning();await this.dropSessionOnly();
      }
    }
    await this.createDeviceSession(caps);await this.verifySession(options);this.markTrustedUiAutomator2Provisioning();
    this.mark('uiautomator2-provisioning', {strategy: 'full-verification', verified: true});
  }
  async ensureSelectedDevice() {
    const records = await this.listDevices(), record = records.find(item => item.serial === this.state.lastDevice);
    if (!record) throw new Error('上次选择的 Android 手机当前未连接；不会自动切换设备。');
    const device = await this.deviceDetails(record), problems = deviceProblems(device);
    if (problems.length) throw new Error(problems.join('\n'));
    this.device = device; return device;
  }
  async reconnect() {
    await this.disconnect(); await this.ensureSelectedDevice();
    try {const caps = await this.startServer();await this.connectAndVerify(caps);} catch (error) {await this.disconnect();throw error;}
  }
  async verifyAndConnect() {
    this.section('连接并验证手机');
    this.out('首次连接会在手机安装 Appium 的 UiAutomator2 测试组件。如系统询问是否允许 USB 安装，请本人在手机上确认。');
    const caps = await this.startServer(); await this.connectAndVerify(caps);
    this.out('真机会话、回主屏、页面结构和截图已验证通过。'); await this.openControl();
  }
  async openControlInBrowser(url) {
    const target = parseLocalControlUrl(url);
    const response = await fetch(target.origin + '/', {redirect: 'error', signal: AbortSignal.timeout(3000)});
    if (!response.ok) throw new Error('本机控制页未就绪，未打开浏览器。');
    try {
      await this.command('/usr/bin/open', [target.href], {label: 'open-control', timeout: 10000});
    } catch (firstError) {
      try {
        await this.command('/usr/bin/osascript',
          ['-e', 'on run argv', '-e', 'open location (item 1 of argv)', '-e', 'end run', '--', target.href],
          {label: 'open-control-fallback', timeout: 10000});
      } catch (fallbackError) {
        throw new Error('控制页已启动，但无法唤起默认浏览器。请重新打开 App。\n' +
          String(firstError?.message || firstError) + '\n' + String(fallbackError?.message || fallbackError));
      }
    }
  }
  async openControl(options = {}) {
    this.automation = this.automation || new AutomationService(this);
    this.ipc = this.ipc || new AutomationIpcServer(this.automation, this.root);
    if (!this.ipc.server) await this.ipc.start();
    this.control = await startControlServer(this, {automationService: this.automation}); this.knownSecrets.push(new URL(this.control.url).hash.slice(1));
    const runDir = path.join(this.root, 'run');
    fs.mkdirSync(runDir, {recursive: true, mode: 0o700});
    const controlUrlFile = path.join(runDir, 'control-url');
    fs.writeFileSync(controlUrlFile, this.control.url + '\n', {mode: 0o600});
    this.controlUrlFile = controlUrlFile;
    await this.openControlInBrowser(this.control.url);
    this.out('安卓控制页已打开：人工界面和 AI 工具层共享同一个设备会话与 AutomationService。');
    this.out('AI 工具层已通过仅当前用户可访问的 Unix Domain Socket 启动；未开放新的 TCP 端口。');
    if (options.waitForTerminal !== false) {
      this.out('保留此窗口即可使用；关闭后会停止本次会话、IPC 和助手启动的服务。');
      await this.ask('用完后按回车退出连接助手：');
    } else {
      this.out('App 后台已接管本次会话；再次双击 App 会直接回到现有控制页。');
    }
  }

  diagnosticSummary() {
    return {tool: VERSION, generatedAt: new Date().toISOString(), platform: process.platform, macOS: this.hostMacOSVersion || '未记录', architecture: process.arch, node: process.version,
      hostCompatibility: {minimumMacOS: HOST_COMPAT.minMacOSMajor + '.0', supportedArchitectures: [...HOST_COMPAT.architectures]},
      platformTools: fs.existsSync(this.adbPath) ? PLATFORM_TOOLS.version : '未安装', java: fs.existsSync(this.javaPath) ? JDK.version : '未安装',
      stack: {appium: this.installedVersion('appium', this.coreDir) || '未安装',
        uiautomator2: this.installedVersion('appium-uiautomator2-driver') || '未安装',
        inspector: this.installedVersion('appium-inspector-plugin') || '未安装',
        scrcpyServer: fs.existsSync(this.scrcpyServerPath) ? SCRCPY_SERVER.version : '未安装'},
      detectedDeviceCount: this.state.detectedDeviceCount ?? null,
      deviceObservation: this.state.deviceObservation ? {checkedAt: this.state.deviceObservation.checkedAt, ...deviceDiagnostic(this.state.deviceObservation)} : null,
      pendingAction: ['usb-authorization', 'install-restricted', 'device-offline'].includes(this.state.pendingAction) ? this.state.pendingAction : null,
      lastFailure: this.state.lastFailure || null,
      streamDiagnostic: this.state.streamDiagnostic || null,
      uiautomator2Provisioning: {strategy: 'verified-device-fast-path-with-safe-fallback', fastPathEligible: this.trustedUiAutomator2Provisioning()},
      aiToolLayer: {protocolVersion: 1, ipcRunning: Boolean(this.ipc?.server)},
      note: '这是白名单摘要；不包含 ADB 序列号、截图、页面结构、输入内容或原始日志。'};
  }
  async diagnostic() {
    this.section('导出可分享诊断');
    const desktop = path.join(os.homedir(), 'Desktop'); fs.mkdirSync(desktop, {recursive: true});
    const destination = path.join(desktop, '安卓连接诊断-' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt');
    fs.writeFileSync(destination, redact(JSON.stringify(this.diagnosticSummary(), null, 2), this.knownSecrets) + '\n', {mode: 0o600, flag: 'wx'});
    this.out('诊断摘要已生成：' + destination); await this.command('/usr/bin/open', ['-R', destination], {label: 'reveal-report'});
  }
  async assertInstalledRuntime() {
    const required = [this.adbPath, this.scrcpyServerPath, this.javaPath, this.appium];
    if (!this.state.stackReady || this.state.stackRuntime !== this.runtimeKey || required.some(file => !fs.existsSync(file))) {
      throw new Paused('专用运行环境尚未安装完整。请重新运行完整安装包里的“安装安卓连接助手.command”。');
    }
    const adbVersion = await this.adb(['version'], {label: 'adb-version', timeout: 10000}).catch(() => '');
    if (!adbVersion.includes(PLATFORM_TOOLS.version)) throw new Paused('专用 ADB 版本异常，请重新运行完整安装包。');
    const javaVersion = await this.command(this.javaPath, ['--version'], {label: 'java-version', timeout: 10000}).catch(() => '');
    if (!compatibleJavaOutput(javaVersion)) throw new Paused('专用 Java 运行环境异常，请重新运行完整安装包。');
    if (this.installedVersion('appium', this.coreDir) !== PACKAGES.appium || this.installedVersion('appium-uiautomator2-driver') !== PACKAGES.uiautomator2 ||
        this.installedVersion('@modelcontextprotocol/server', this.coreDir) !== PACKAGES.mcpServer) throw new Paused('专用自动化依赖版本不完整，请重新运行完整安装包。');
    await this.verifyMcpSdk();
  }
  async selectDeviceForApp() {
    const records = await this.listDevices();
    let selected = this.state.lastDevice ? records.find(item => item.serial === this.state.lastDevice) : null;
    if (!selected && !this.state.lastDevice && records.length === 1) selected = records[0];
    if (!selected) {
      if (this.state.lastDevice) throw new Paused('上次使用的 Android 手机当前未连接。请连接该手机；如需换手机，请运行完整安装包或“打开安卓连接助手.command”。');
      if (records.length > 1) throw new Paused('检测到多台 Android 设备。首次选择设备请运行完整安装包或“打开安卓连接助手.command”。');
      throw new Paused('没有检测到可用的 Android 手机。请连接数据线、解锁并允许 USB 调试后重新打开 App。');
    }
    this.knownSecrets.push(selected.serial);
    const device = await this.deviceDetails(selected), problems = deviceProblems(device);
    this.recordObservation(device, records.length);
    if (problems.length) throw new Paused(problems.join('\n'));
    this.device = device; this.state.lastDevice = device.serial; this.save();
    return device;
  }
  async app() {
    this.state.lastFailure = null; this.state.detectedDeviceCount = null; this.state.deviceObservation = null; this.save();
    await this.inspectEnvironment();
    await this.assertInstalledRuntime();
    // App 启动只打开设备大厅和控制服务。手机发现/连接由控制页显式触发，避免启动时强制等待设备。
    await this.openControl({waitForTerminal: false});
  }
  async provision() {
    this.state.lastFailure = null;this.state.detectedDeviceCount = null;this.state.deviceObservation = null;this.state.streamDiagnostic = null;this.save();
    this.out('安装阶段只准备 Mac 本机环境，不要求连接手机。安装完成后可随时打开 App，再手动选择并连接设备。');
    await this.inspectEnvironment();
    await this.installPlatformTools();
    await this.installScrcpyServer();
    await this.installStack();
    this.out('\n安装完成：安卓连接助手已就绪。现在无需连接手机。');
    if (process.stdin.isTTY) {
      const answer = await this.ask('现在打开安卓连接助手？直接回车打开；输入 n 稍后再开：');
      if (!/^n$/i.test(answer)) await this.command('/usr/bin/open', [path.join(os.homedir(), 'Applications', '安卓连接助手.app')], {label: 'open-installed-app'});
    }
  }
  async setup() {
    this.state.lastFailure = null; this.state.detectedDeviceCount = null; this.state.deviceObservation = null; this.state.streamDiagnostic = null; this.save();
    await this.inspectEnvironment(); await this.installPlatformTools(); await this.installScrcpyServer(); await this.chooseDevice(); await this.installStack(); await this.verifyAndConnect();
  }
  async menu(initial = 'menu') {
    this.out('\n安卓连接助手 ' + VERSION + ' · 轻量浏览器版');
    this.out('只操作你明确选择的 Android 手机；q 可随时暂停。请不要在此窗口输入账号密码。');
    if (initial === 'setup') return this.setup();
    if (initial === 'provision') return this.provision();
    this.out('1. 一键连接（默认）\n2. 日常启动\n3. 重新安装专用依赖\n4. 导出可分享诊断\n5. 查看本机日志目录\n6. 更换手机');
    const selected = await this.ask('选择编号（默认 1）：');
    if (selected === '4') return this.diagnostic();
    if (selected === '5') return this.command('/usr/bin/open', [path.join(this.root, 'logs')], {label: 'open-logs'});
    if (selected === '6') {delete this.state.lastDevice;this.save();return this.setup();}
    if (!['', '1', '2', '3'].includes(selected)) throw new Paused('未选择有效菜单项。');
    if (selected === '3') {this.state.stackReady = false;try {if (fs.existsSync(this.scrcpyServerPath) && !fs.lstatSync(this.scrcpyServerPath).isSymbolicLink()) fs.unlinkSync(this.scrcpyServerPath);} catch {}this.save();}
    return this.setup();
  }
  async disconnect() {
    if (this.session && this.base) {
      try {await this.http(this.base, '/session/' + encodeURIComponent(this.session), 'DELETE', undefined, 8000);} catch {}
      this.session = null; this.screenRect = null;
    }
    this.screenRect = null;
    try {fs.unlinkSync(path.join(this.root, 'config', 'active-session.json'));} catch {}
    const processes = [...this.children, ...(this.server ? [this.server] : [])];
    for (const child of processes) this.terminateChild(child);
    if (processes.length) {await sleep(800);for (const child of processes) this.terminateChild(child, 'SIGKILL');}
    this.children.clear();this.server = null;this.base = null;
  }
  async cleanup() {
    if (this.control) {await this.control.close();this.control = null;}
    if (this.controlUrlFile) {try {fs.unlinkSync(this.controlUrlFile);} catch {}this.controlUrlFile = null;}
    if (this.ipc) {await this.ipc.close().catch(() => {});this.ipc = null;}
    this.automation = null;await this.disconnect();
  }
}

function rootSafe(root) {fs.mkdirSync(root, {recursive: true, mode: 0o700});return root;}

async function main() {
  if (process.platform !== 'darwin') {console.error('此发行包仅在 macOS 执行。');process.exitCode = 1;return;}
  process.umask(0o077);
  const root = path.join(os.homedir(), 'Library', 'Application Support', 'AndroidLink');
  fs.mkdirSync(root, {recursive: true, mode: 0o700});
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('专用数据目录是符号链接，已停止。');
  const lock = path.join(root, 'assistant.lock');
  if (fs.existsSync(lock)) {
    const existing = readJson(lock);let alive = false;
    if (Number.isInteger(existing?.pid) && existing.pid > 1) {try {process.kill(existing.pid, 0);alive = true;} catch (error) {alive = error.code === 'EPERM';}}
    if (alive) throw new Error('另一个助手窗口仍在运行，请回到原窗口。');
    fs.renameSync(lock, lock + '.stale-' + crypto.randomUUID());
  }
  fs.writeFileSync(lock, JSON.stringify({pid: process.pid}), {flag: 'wx', mode: 0o600});
  let helper, stopping = false;
  const release = () => {if (readJson(lock)?.pid === process.pid) fs.unlinkSync(lock);};
  try {
    helper = new Assistant(root);
    const stop = async () => {if (stopping) return;stopping = true;helper.out('\n正在停止本次操作和助手启动的服务…');await helper.cleanup();release();process.exit(130);};
    process.once('SIGINT', stop);process.once('SIGTERM', stop);process.once('SIGHUP', stop);
    const mode = process.argv[2] || 'menu';
    try {
      if (mode === 'app') {await helper.app();await new Promise(() => {});}
      else await helper.menu(mode);
    }
    catch (error) {
      const hint = error instanceof Paused ? error.message : errorHint(error.message);
      helper.state.lastFailure = {at: new Date().toISOString(), step: helper.currentStep || '初始化', command: error.commandLabel || helper.currentCommand || null,
        category: error instanceof Paused ? 'paused' : errorCategory(error.message), hint: redact(hint, helper.knownSecrets),
        evidence: error instanceof Paused ? [] : errorEvidence(error.message).map(line => redact(line, helper.knownSecrets)), code: error.code || null};
      helper.save(); helper.out('\n已暂停：' + hint);
      if (!(error instanceof Paused)) {helper.out('原始错误节选：\n' + redact(error.message, helper.knownSecrets).split('\n').slice(-12).join('\n'));
        helper.out('本机日志目录：' + helper.logDir + '（原始文件不要直接转发）');}
      await helper.cleanup();
      if (mode === 'app') {
        try {await helper.command('/usr/bin/osascript', ['-e','on run argv','-e','display alert "安卓连接助手" message (item 1 of argv) as warning buttons {"好"} default button "好"','-e','end run','--', hint], {label:'app-alert',timeout:10000});} catch {}
      } else {try {await helper.diagnostic();} catch {}}
      process.exitCode = error instanceof Paused ? 0 : 1;
    } finally {await helper.cleanup();}
    if (!stopping && process.stdin.isTTY && mode !== 'provision') {try {await helper.ask('本次操作已结束，按回车关闭：');} catch {}}
  } finally {release();}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {console.error(error.message);process.exitCode = 1;});
}
