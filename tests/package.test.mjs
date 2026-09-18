import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const resources = path.join(root, 'src');
const app = path.join(root, 'packaging');

const requiredResources = [
  'bootstrap.zsh', 'core.mjs', 'wizard.mjs', 'control.mjs', 'control.html',
  'control.js', 'control.css', 'refresh-scheduler.mjs', 'video-stream.mjs', 'stream-client.mjs', 'stream-recovery.mjs', 'mjpeg-stream.mjs', 'phone-recording.mjs', '连接手机.command',
  'automation-errors.mjs', 'automation-protocol.mjs', 'automation-service.mjs', 'ipc-server.mjs', 'ipc-client.mjs',
  'control-lease.mjs', 'ui-tree.mjs', 'selectors.mjs', 'checkpoint.mjs', 'runtime-spec-provider.mjs', 'cli.mjs', 'mcp-server.mjs', 'ai-integration.mjs', 'update-manager.mjs', 'component-manifest.json',
  'schemas/ipc-request.schema.json', 'schemas/ipc-response.schema.json', 'schemas/snapshot.schema.json', 'schemas/selector.schema.json', 'schemas/runtime-spec.schema.json',
];

test('release bundle contains every control-page resource required at runtime', () => {
  for (const file of requiredResources) {
    const target = path.join(resources, file);
    const info = fs.lstatSync(target);
    assert.equal(info.isFile(), true, `${file} must be a regular file`);
    assert.equal(info.isSymbolicLink(), false, `${file} must not be a symlink`);
  }
  const launcher = fs.lstatSync(path.join(app, 'launcher'));
  assert.equal(launcher.isFile(), true);
  assert.equal(launcher.isSymbolicLink(), false);
});

test('release metadata is 0.5.6 build 39 with AI protocol version 1', () => {
  const plist = fs.readFileSync(path.join(app, 'Info.plist'), 'utf8');
  assert.match(plist, /<key>CFBundleShortVersionString<\/key><string>0\.5\.6<\/string>/);
  assert.match(plist, /<key>CFBundleVersion<\/key><string>39<\/string>/);
  const core = fs.readFileSync(path.join(resources, 'core.mjs'), 'utf8');
  assert.match(core, /VERSION\s*=\s*['"]0\.5\.6['"]/);
  const protocol = fs.readFileSync(path.join(resources, 'automation-protocol.mjs'), 'utf8');
  assert.match(protocol, /AUTOMATION_PROTOCOL_VERSION\s*=\s*1/);
});


test('macOS 12+ release pins Node 22.16.0 and supports native arm64/x64 runtime selection', () => {
  const plist = fs.readFileSync(path.join(app, 'Info.plist'), 'utf8');
  const bootstrap = fs.readFileSync(path.join(resources, 'bootstrap.zsh'), 'utf8');
  const core = fs.readFileSync(path.join(resources, 'core.mjs'), 'utf8');
  const wizard = fs.readFileSync(path.join(resources, 'wizard.mjs'), 'utf8');
  const browser = fs.readFileSync(path.join(resources, 'control.js'), 'utf8');
  assert.match(plist, /<key>LSMinimumSystemVersion<\/key><string>12\.0<\/string>/);
  assert.match(bootstrap, /NODE_VERSION='v22\.16\.0'/);
  assert.match(bootstrap, /MAC_MAJOR >= 12/);
  assert.match(bootstrap, /NODE_ARCH=arm64/);
  assert.match(bootstrap, /NODE_ARCH=x64/);
  assert.match(bootstrap, /node-v22\.16\.0-darwin-\$ARCH/);
  assert.doesNotMatch(bootstrap, /node-v24\./);
  assert.match(core, /minMacOSMajor:\s*12/);
  assert.match(core, /nodeVersion:\s*'22\.16\.0'/);
  assert.match(core, /architectures:\s*Object\.freeze\(\['arm64', 'x64'\]\)/);
  assert.match(core, /OpenJDK17U-jdk_aarch64_mac_hotspot/);
  assert.match(core, /OpenJDK17U-jdk_x64_mac_hotspot/);
  assert.match(wizard, /sw_vers/);
  assert.match(wizard, /process\.version !== 'v' \+ HOST_COMPAT\.nodeVersion/);
  assert.match(wizard, /stackRuntime/);
  assert.doesNotMatch(browser, /Object\.hasOwn\(/);
  assert.match(browser, /Object\.prototype\.hasOwnProperty\.call/);
});

test('installer validates bundle resources and launcher handles App Translocation', () => {
  const bootstrap = fs.readFileSync(path.join(resources, 'bootstrap.zsh'), 'utf8');
  const launcher = fs.readFileSync(path.join(app, 'launcher'), 'utf8');
  assert.match(bootstrap, /validate_app_bundle/);
  assert.match(bootstrap, /control\.html/);
  assert.match(bootstrap, /video-stream\.mjs/);
  assert.match(bootstrap, /stream-client\.mjs/);
  assert.match(bootstrap, /mjpeg-stream\.mjs/);
  assert.match(bootstrap, /stream-recovery\.mjs/);
  assert.match(bootstrap, /automation-service\.mjs/);
  assert.match(bootstrap, /ipc-server\.mjs/);
  assert.match(bootstrap, /mcp-server\.mjs/);
  assert.match(bootstrap, /ai-integration\.mjs/);
  assert.match(bootstrap, /update-manager\.mjs/);
  assert.match(bootstrap, /component-manifest\.json/);
  assert.match(bootstrap, /seed_code_bundle/);
  assert.match(bootstrap, /modules\/active-code/);
  assert.match(bootstrap, /snapshot\.schema\.json/);
  const wizard = fs.readFileSync(path.join(resources, 'wizard.mjs'), 'utf8');
  const core = fs.readFileSync(path.join(resources, 'core.mjs'), 'utf8');
  assert.match(wizard, /@modelcontextprotocol\/server@/);
  assert.match(wizard, /--save-exact/);
  assert.match(core, /mcpServer:\s*['"]2\.0\.0['"]/);
  assert.match(bootstrap, /android-link-mcp/);
  assert.match(launcher, /\$HOME\/Applications\/安卓连接助手\.app/);
  assert.match(launcher, /SELF_APP=/);
  assert.match(launcher, /assistant_pid/);
  assert.match(launcher, /curl --silent/);
  assert.match(launcher, /open location/);
  assert.match(launcher, /bootstrap\.zsh\" app/);
  assert.doesNotMatch(launcher, /com\.apple\.Terminal/);
  assert.match(launcher, /run\/control-url/);
});

test('realtime streaming has H264 downgrade, MJPEG fallback and local security boundaries', () => {
  const browser = fs.readFileSync(path.join(resources, 'control.js'), 'utf8');
  const server = fs.readFileSync(path.join(resources, 'control.mjs'), 'utf8');
  assert.match(browser, /playRealtimeStream/);
  assert.match(browser, /playMjpegStream/);
  assert.match(server, /adaptiveStreamAttempts/);
  assert.match(server, /listH264Encoders/);
  assert.match(server, /ScrcpyControlStream/);
  assert.match(server, /api\/video-size/);
  assert.match(server, /api\/stream-feedback/);
  assert.match(server, /api\/mjpeg/);
  assert.match(server, /server\.listen\(0,\s*'127\.0\.0\.1'/);
  assert.match(server, /timingSafeEqual/);
  assert.match(server, /size\s*>\s*16384/);
  assert.match(server, /Content-Security-Policy/);
});


test('device-adaptive profile negotiates refresh, encoder, MJPEG quality and control independently', () => {
  const server = fs.readFileSync(path.join(resources, 'control.mjs'), 'utf8');
  const video = fs.readFileSync(path.join(resources, 'video-stream.mjs'), 'utf8');
  const mjpeg = fs.readFileSync(path.join(resources, 'mjpeg-stream.mjs'), 'utf8');
  const browser = fs.readFileSync(path.join(resources, 'control.js'), 'utf8');
  assert.match(video, /chooseDeviceRefreshRate/);
  assert.match(video, /adaptiveStreamAttempts/);
  assert.match(video, /attempts\.length\s*>=\s*8/);
  assert.match(video, /class ScrcpyControlStream/);
  assert.match(mjpeg, /adaptiveMjpegProfile/);
  assert.match(server, /streamProfiles/);
  assert.match(server, /X-AndroidLink-Touch/);
  assert.match(browser, /reportStreamFeedback/);
  assert.match(browser, /reportVideoSize/);
});


test('interaction layer uses direct scrcpy touch, precise fallback drag and gray pointer states', () => {
  const browser = fs.readFileSync(path.join(resources, 'control.js'), 'utf8');
  const server = fs.readFileSync(path.join(resources, 'control.mjs'), 'utf8');
  const video = fs.readFileSync(path.join(resources, 'video-stream.mjs'), 'utf8');
  const css = fs.readFileSync(path.join(resources, 'control.css'), 'utf8');
  assert.match(server, /\/api\/touch/);
  assert.match(server, /preciseDragActions/);
  assert.match(server, /controlEnabled: false/);
  assert.match(server, /ensureTouchStream\(true\)/);
  assert.match(server, /pipeline: videoPipeline/);
  assert.match(video, /control=true|control=' \+ \(this\.controlEnabled/);
  assert.match(video, /touchMessage/);
  assert.match(video, /onControlError/);
  assert.match(browser, /1:1 距离映射/);
  assert.match(browser, /queueDirectMove/);
  assert.match(css, /pointer-indicator\.dragging/);
  assert.doesNotMatch(css, /cursor:crosshair/);
  assert.match(css, /cursor:none/);
});


test('quick swipe controls use literal finger directions and visible running feedback', () => {
  const browser = fs.readFileSync(path.join(resources, 'control.js'), 'utf8');
  const server = fs.readFileSync(path.join(resources, 'control.mjs'), 'utf8');
  const css = fs.readFileSync(path.join(resources, 'control.css'), 'utf8');
  assert.match(server, /quickSwipeActions/);
  assert.match(server, /call\('\/actions', 'POST', gesture\.body/);
  assert.doesNotMatch(server, /mobile: swipeGesture/);
  assert.match(browser, /正在下滑/);
  assert.match(browser, /swipeCopy/);
  assert.match(css, /\.swipes button\.running/);
});


test('H264 self-healing keeps MJPEG alive during probe and promotes only a decoded probe stream', () => {
  const browser = fs.readFileSync(path.join(resources, 'control.js'), 'utf8');
  const server = fs.readFileSync(path.join(resources, 'control.mjs'), 'utf8');
  const html = fs.readFileSync(path.join(resources, 'control.html'), 'utf8');
  const recovery = fs.readFileSync(path.join(resources, 'stream-recovery.mjs'), 'utf8');
  assert.match(browser, /attemptH264Recovery/);
  assert.match(browser, /probe:true/);
  assert.match(browser, /promote-stream/);
  assert.match(browser, /waitForInteractionIdle/);
  assert.match(browser, /后台探测中 · 当前 MJPEG 画面不受影响/);
  assert.match(server, /requestURL\.searchParams\.get\('probe'\) === '1'/);
  assert.match(server, /probeStream/);
  assert.match(server, /api\/promote-stream/);
  assert.match(server, /recoveredFrom: 'mjpeg-background-probe'/);
  assert.match(html, /id="videoProbe"/);
  assert.match(html, /id="h264Health"/);
  assert.match(recovery, /H264_RETRY_DELAYS_MS/);
});


test('preview display has fixed small medium large sizes independent of viewport height', () => {
  const browser = fs.readFileSync(path.join(resources, 'control.js'), 'utf8');
  const css = fs.readFileSync(path.join(resources, 'control.css'), 'utf8');
  const html = fs.readFileSync(path.join(resources, 'control.html'), 'utf8');
  const server = fs.readFileSync(path.join(resources, 'control.mjs'), 'utf8');
  assert.match(browser, /PREVIEW_SIZES=Object\.freeze\(\{small:320,medium:400,large:480\}\)/);
  assert.match(browser, /api\('ui-preference',\{previewSize:size\}/);
  assert.match(browser, /previewSizeInitialized/);
  assert.match(server, /previewSize: normalizePreviewSize\(helper\.state\?\.uiPreferences\?\.previewSize\)/);
  assert.match(server, /route === '\/api\/ui-preference'/);
  assert.match(html, /data-preview-size="small"/);
  assert.match(html, /data-preview-size="medium"/);
  assert.match(html, /data-preview-size="large"/);
  assert.match(css, /data-display-size="small"\]\{--phone-display-width:320px\}/);
  assert.match(css, /data-display-size="medium"\]\{--phone-display-width:400px\}/);
  assert.match(css, /data-display-size="large"\]\{--phone-display-width:480px\}/);
  assert.match(css, /width:min\(var\(--phone-display-width\),100%\)/);
  assert.doesNotMatch(css, /max-height:calc\(100vh/);
  assert.doesNotMatch(css, /max-height:68vh/);
});

test('MJPEG touch control self-heals and clearly reports realtime versus compatibility mode', () => {
  const browser = fs.readFileSync(path.join(resources, 'control.js'), 'utf8');
  const server = fs.readFileSync(path.join(resources, 'control.mjs'), 'utf8');
  const html = fs.readFileSync(path.join(resources, 'control.html'), 'utf8');
  assert.match(server, /scheduleTouchRetry/);
  assert.match(server, /touchStreamPromise/);
  assert.match(server, /touchControl: touchControlState\(\)/);
  assert.match(server, /ensureTouchStream\(true\)\.catch/);
  assert.match(browser, /scheduleTouchHealthPolling/);
  assert.match(browser, /gestureDirectTouch/);
  assert.match(browser, /手机边拖边动/);
  assert.match(browser, /Appium 兼容模式 · 松手后执行/);
  assert.match(html, /id="touchMode"/);
});


test('phone-native recording is local-only, pull-safe and independent from realtime preview', () => {
  const server = fs.readFileSync(path.join(resources, 'control.mjs'), 'utf8');
  const recorder = fs.readFileSync(path.join(resources, 'phone-recording.mjs'), 'utf8');
  const browser = fs.readFileSync(path.join(resources, 'control.js'), 'utf8');
  const html = fs.readFileSync(path.join(resources, 'control.html'), 'utf8');
  const bootstrap = fs.readFileSync(path.join(resources, 'bootstrap.zsh'), 'utf8');
  assert.match(recorder, /buildScreenrecordScript/);
  assert.match(recorder, /child\.stdin\.end\(remoteScript\)/);
  assert.match(recorder, /\['-s', serial, 'shell', 'sh'\]/);
  assert.doesNotMatch(recorder, /\['-s', serial, 'shell', 'sh', '-c'/);
  assert.match(recorder, /screenrecordProfiles/);
  assert.match(recorder, /兼容高清/);
  assert.match(server, /H\.264 后台探测已暂停/);
  assert.match(recorder, /\/sdcard\/AndroidLink\/recordings/);
  assert.match(recorder, /recording-pull/);
  assert.match(recorder, /手机临时文件仍保留/);
  assert.match(server, /\/api\/start-recording/);
  assert.match(server, /\/api\/stop-recording/);
  assert.match(server, /\/api\/open-recording-folder/);
  assert.match(browser, /停止手机录屏并回传到 Mac/);
  assert.match(html, /id="record"/);
  assert.match(bootstrap, /phone-recording\.mjs/);
});


test('control server publishes its localhost origin inside the listen callback before startup resolves', () => {
  const server = fs.readFileSync(path.join(resources, 'control.mjs'), 'utf8');
  assert.match(server, /server\.listen\(0, '127\.0\.0\.1', \(\) => \{[\s\S]*origin = 'http:\/\/127\.0\.0\.1:' \+ server\.address\(\)\.port;[\s\S]*resolve\(\);/);
  assert.doesNotMatch(server, /server\.listen\(0, '127\.0\.0\.1', resolve\);\s*\}\);\s*origin =/);
});


test('public source repository includes bilingual MCP docs without embedded runtime secrets', () => {
  const files = ['MCP.md','MCP.zh-CN.md','ARCHITECTURE.md','ARCHITECTURE.zh-CN.md'];
  for (const file of files) {
    const info = fs.lstatSync(path.join(root, 'docs', file));
    assert.equal(info.isFile(), true, `${file} must exist`);
    assert.equal(info.isSymbolicLink(), false, `${file} must not be a symlink`);
  }
  const docs = files.map(file=>fs.readFileSync(path.join(root,'docs',file),'utf8')).join('\n');
  assert.match(docs, /android-link-mcp/);
  assert.doesNotMatch(docs, /assistant\.secret\s*[:=]\s*[A-Fa-f0-9]{32,}/);
});


test('public source tree keeps packaging inputs explicit and separate from runtime source', () => {
  for (const file of ['README.md','README.zh-CN.md','LICENSE','SECURITY.md','SECURITY.zh-CN.md','KNOWN_ISSUES.md','KNOWN_ISSUES.zh-CN.md']) {
    assert.equal(fs.existsSync(path.join(root,file)),true,file);
  }
  const installer = fs.readFileSync(path.join(root,'scripts','install-from-package.command'),'utf8');
  assert.match(installer,/\.payload\/安卓连接助手\.app/);
  const launcher = fs.readFileSync(path.join(root,'packaging','launcher'),'utf8');
  assert.match(launcher,/\/usr\/bin\/open "\$url"/);
  assert.doesNotMatch(launcher,/WKWebView|JavaScript for Automation|NSApplication/);
  assert.equal(fs.existsSync(path.join(root,'scripts','build-release.sh')),true);
});

test('MCP entry uses the official v2 stdio handle shape instead of treating serveStdio as a Promise', () => {
  const source = fs.readFileSync(path.join(resources, 'mcp-server.mjs'), 'utf8');
  assert.match(source, /requireSdk\.resolve\('@modelcontextprotocol\/server'\)/);
  assert.match(source, /pathToFileURL/);
  assert.match(source, /stdioHandle\s*=\s*serveStdio/);
  assert.match(source, /stdioHandle\?\.close/);
  assert.doesNotMatch(source, /serveStdio\([^\n]+\)\.catch/);
});

test('published Selector schema matches runtime limits and recursively validates within selectors', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(resources, 'schemas', 'selector.schema.json'), 'utf8'));
  assert.equal(schema.properties.qaId.maxLength, 220);assert.equal(schema.properties.resourceId.maxLength, 220);assert.equal(schema.properties.className.maxLength, 220);
  assert.deepEqual(schema.properties.within, {$ref:'#'});
  const text = schema.$defs.textMatch.oneOf;assert.equal(text.find(v=>v.type==='string').maxLength,200);assert.equal(text.find(v=>v.type==='object').properties.equals.maxLength,200);
});

test('all visible manual control buttons keep an explicit browser handler or delegated direction/size handler', () => {
  const html = fs.readFileSync(path.join(resources, 'control.html'), 'utf8'), browser = fs.readFileSync(path.join(resources, 'control.js'), 'utf8');
  for (const id of ['back','home','recent','refresh','save','record','openShots','openRecordings','takeover','input','reconnect','disconnect','source']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));assert.match(browser, new RegExp(`\\$\\('${id}'\\)\\.onclick`));
  }
  assert.match(browser,/querySelectorAll\('\[data-direction\]'\)\.forEach\(b=>b\.onclick/);
  assert.match(browser,/querySelectorAll\('\[data-preview-size\]'\)\.forEach\(button=>button\.onclick/);
});

test('advanced checks include live diagnostics monitor and one-click redacted export', () => {
  const html = fs.readFileSync(path.join(resources, 'control.html'), 'utf8');
  const browser = fs.readFileSync(path.join(resources, 'control.js'), 'utf8');
  const server = fs.readFileSync(path.join(resources, 'control.mjs'), 'utf8');
  assert.match(html, /id="advancedChecks"/);
  assert.match(html, /id="diagUsb"/);
  assert.match(html, /id="diagSession"/);
  assert.match(html, /id="diagRealtime"/);
  assert.match(html, /id="exportDiagnostic"/);
  assert.match(browser, /scheduleDiagnosticPolling\(2000\)/);
  assert.match(browser, /api\('export-diagnostic'/);
  assert.match(server, /\/api\/diagnostics/);
  assert.match(server, /\/api\/export-diagnostic/);
  assert.match(server, /不包含截图、页面结构、输入文字、控制页 Token 或 ADB 序列号/);
});


test('AI integration card supports auto-detect, safe one-click clients, manual copy fallback and independent MCP self-test', () => {
  const html = fs.readFileSync(path.join(resources, 'control.html'), 'utf8');
  const browser = fs.readFileSync(path.join(resources, 'control.js'), 'utf8');
  const server = fs.readFileSync(path.join(resources, 'control.mjs'), 'utf8');
  const integration = fs.readFileSync(path.join(resources, 'ai-integration.mjs'), 'utf8');
  const mcp = fs.readFileSync(path.join(resources, 'mcp-server.mjs'), 'utf8');
  assert.match(html, /id="aiIntegrationCard"/);
  assert.match(html, /id="copyMcpJson"/);
  assert.match(html, /id="copyMcpToml"/);
  assert.match(html, /id="copyMcpCommand"/);
  assert.match(html, /id="testMcp"/);
  assert.ok(html.indexOf('id="aiIntegrationCard"') > html.indexOf('class="card session-card"'), 'AI 接入应位于常用输入/连接操作之后');
  assert.ok(html.indexOf('id="aiIntegrationCard"') < html.indexOf('id="advancedChecks"'), 'AI 接入应紧邻高级检查上方');
  assert.match(browser, /api\('ai-integrations'/);
  assert.match(browser, /api\(action==='connect'\?'ai-connect':'ai-remove'/);
  assert.match(browser, /api\('mcp-test'/);
  assert.match(server, /\/api\/ai-integrations/);
  assert.match(server, /\/api\/ai-connect/);
  assert.match(server, /\/api\/ai-remove/);
  assert.match(server, /\/api\/mcp-test/);
  assert.match(integration, /mcpServers/);
  assert.match(integration, /mcp_servers/);
  assert.match(integration, /SERVER_NAME/);
  assert.match(integration, /ANDROID_LINK_MANAGED/);
  assert.match(integration, /未检测到 Codex/);
  assert.match(mcp, /ANDROID_LINK_MCP_SELF_TEST/);
  assert.match(mcp, /toolCount/);
});
