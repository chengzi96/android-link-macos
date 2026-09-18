import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {AutomationService} from '../src/automation-service.mjs';
import {AutomationIpcServer} from '../src/ipc-server.mjs';
import {ipcCall} from '../src/ipc-client.mjs';
import {ControlLeaseManager} from '../src/control-lease.mjs';
import {AutomationError} from '../src/automation-errors.mjs';
import {parseAndroidTree} from '../src/ui-tree.mjs';
import {findElements, uniqueElement} from '../src/selectors.mjs';
import {startControlServer} from '../src/control.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'..');
const resources=path.join(root,'src');

function pngBase64(width=1080,height=2400){const png=Buffer.alloc(256,1);Buffer.from('89504e470d0a1a0a','hex').copy(png,0);png.writeUInt32BE(width,16);png.writeUInt32BE(height,20);return png.toString('base64');}
const initialXml=`<?xml version="1.0"?><hierarchy><node package="com.example.test" class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">
<node resource-id="com.example:id/buy" class="android.widget.Button" text="Buy now" content-desc="Buy now" clickable="true" enabled="true" displayed="true" bounds="[48,2100][1032,2244]"/>
<node resource-id="com.example:id/search" class="android.widget.EditText" text="" clickable="true" focusable="true" enabled="true" displayed="true" bounds="[48,120][1032,240]"/>
<node resource-id="com.example:id/item" class="android.widget.TextView" text="Dress" clickable="true" enabled="true" displayed="true" bounds="[48,400][500,500]"/>
<node resource-id="com.example:id/item" class="android.widget.TextView" text="Dress" clickable="true" enabled="true" displayed="true" bounds="[48,520][500,620]"/>
</node></hierarchy>`;

function fakeHelper(tmp, options={}){
  let xml=options.xml||initialXml; const calls=[];
  const helper={root:tmp,session:options.connected===false?null:'session-one',base:'http://127.0.0.1:4723',screenRect:{x:0,y:0,width:1080,height:2400},device:{model:'Fake Phone',os:'15',serial:'SERIAL-PRIVATE'},knownSecrets:[],calls,
    get xml(){return xml;},set xml(value){xml=value;},
    async http(base,route,method='GET',body){calls.push({route,method,body});
      if(route.endsWith('/source')) return xml;
      if(route.endsWith('/screenshot')) return pngBase64();
      if(route.endsWith('/window/rect')) return {x:0,y:0,width:1080,height:2400};
      if(route.endsWith('/appium/device/current_package')) return 'com.example.test';
      if(route.endsWith('/appium/device/current_activity')) return '.MainActivity';
      if(route.endsWith('/element/active')) return {'element-6066-11e4-a52e-4f735466cecf':'active-1'};
      if(route.includes('/element/active-1/value')) return null;
      if(route.endsWith('/execute/sync')) return null;
      if(route.endsWith('/actions')) return null;
      throw new Error('unexpected route '+route);
    },
    async command(cmd,args){calls.push({command:path.basename(cmd),args});if(args?.includes('density'))return 'Physical density: 480\n';return '';},
    async adb(args,options){calls.push({adb:args,options});return '';},
    async disconnect(){this.session=null;this.screenRect=null;},async reconnect(){this.session='session-one';this.screenRect={x:0,y:0,width:1080,height:2400};},
  };return helper;
}
function temp(t,prefix='android-ai-test-'){const dir=fs.mkdtempSync(path.join(os.tmpdir(),prefix));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function rawIpc(socketPath,value){return new Promise((resolve,reject)=>{const s=net.createConnection(socketPath);let text='';s.once('connect',()=>s.write(typeof value==='string'?value:JSON.stringify(value)+'\n'));s.on('data',c=>{text+=c.toString();if(text.includes('\n')){try{resolve(JSON.parse(text.split('\n')[0]));}catch(e){reject(e);}s.destroy();}});s.once('error',reject);});}
function spawnNode(file,args=[],env={}){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[file,...args],{env:{...process.env,...env},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));});}

// IPC security / protocol

test('AI IPC directory, socket and rotating secret use private permissions and are cleaned on exit', async t=>{
  const dir=temp(t),service={dispatch:async()=>({ok:true})},ipc=new AutomationIpcServer(service,dir);await ipc.start();
  assert.equal(fs.statSync(path.join(dir,'ipc')).mode&0o777,0o700);assert.equal(fs.statSync(ipc.secretPath).mode&0o777,0o600);assert.equal(fs.statSync(ipc.socketPath).mode&0o777,0o600);
  const secret=fs.readFileSync(ipc.secretPath,'utf8').trim();assert.match(secret,/^[a-f0-9]{64}$/);
  await ipc.close();assert.equal(fs.existsSync(ipc.socketPath),false);assert.equal(fs.existsSync(ipc.secretPath),false);
});

test('AI IPC rejects invalid secret, unsupported protocol and oversized request', async t=>{
  const dir=temp(t),ipc=new AutomationIpcServer({dispatch:async()=>({ok:true})},dir);await ipc.start();t.after(()=>ipc.close());
  const wrong=await rawIpc(ipc.socketPath,{protocolVersion:1,requestId:'request-0001',method:'status',params:{},auth:'0'.repeat(64)});assert.equal(wrong.error.code,'AUTH_FAILED');
  const secret=fs.readFileSync(ipc.secretPath,'utf8').trim();const version=await rawIpc(ipc.socketPath,{protocolVersion:999,requestId:'request-0002',method:'status',params:{},auth:secret});assert.equal(version.error.code,'PROTOCOL_VERSION_UNSUPPORTED');
  const huge=await rawIpc(ipc.socketPath,JSON.stringify({protocolVersion:1,requestId:'request-0003',method:'status',params:{blob:'x'.repeat(270000)},auth:secret})+'\n');assert.equal(huge.error.code,'RATE_LIMITED');
});

test('same IPC requestId returns cached write result and does not click twice', async t=>{
  const dir=temp(t);let calls=0;const ipc=new AutomationIpcServer({dispatch:async(method)=>{calls++;return {method,calls};}},dir);await ipc.start();t.after(()=>ipc.close());
  const id='repeat-write-0001';const a=await ipcCall('tap',{leaseId:'x'},{root:dir,requestId:id});const b=await ipcCall('tap',{leaseId:'x'},{root:dir,requestId:id});assert.deepEqual(b,a);assert.equal(calls,1);
});

// Lease behavior

test('control lease acquires, renews, conflicts, expires, releases and hides leaseId from status', async()=>{
  let now=1000;const lease=new ControlLeaseManager({now:()=>now,defaultTtlMs:5000,maxTtlMs:10000});const a=lease.acquire('codex',5000);assert.ok(a.leaseId);assert.equal(lease.current().leaseId,undefined);assert.equal(lease.current().owner,'codex');
  assert.throws(()=>lease.acquire('claude',5000),e=>e.code==='LEASE_CONFLICT');assert.throws(()=>lease.acquire('codex',5000),e=>e.code==='LEASE_CONFLICT');const renewed=lease.renew(a.leaseId,8000);assert.equal(renewed.leaseId,a.leaseId);now+=9000;assert.throws(()=>lease.require(a.leaseId),e=>e.code==='LEASE_EXPIRED');
  const b=lease.acquire('claude',5000);assert.equal(lease.release(b.leaseId).released,true);assert.equal(lease.current().active,false);
});

test('human takeover revokes AI lease but does not interrupt an active AI drag', async()=>{
  const lease=new ControlLeaseManager();const acquired=lease.acquire('codex');let releaseDrag;const dragging=lease.withWriter({kind:'drag',owner:'codex',leaseId:acquired.leaseId},()=>new Promise(r=>releaseDrag=r));
  await new Promise(r=>setTimeout(r,5));assert.throws(()=>lease.takeoverByHuman(),e=>e.code==='LEASE_CONFLICT');releaseDrag({ok:true});await dragging;const result=lease.takeoverByHuman();assert.equal(result.previousOwner,'codex');assert.equal(lease.current().active,false);
});

// Selector / snapshot / service behavior

test('selectors support resourceId/text/contentDescription/class, ambiguity and stale element references',()=>{
  const tree=parseAndroidTree(initialXml);assert.equal(findElements(tree,{resourceId:'com.example:id/buy'}).length,1);assert.equal(findElements(tree,{text:{equals:'Buy now'}}).length,1);assert.equal(findElements(tree,{contentDescription:{equals:'Buy now'}}).length,1);assert.equal(findElements(tree,{className:'android.widget.Button',clickable:true}).length,1);
  assert.throws(()=>uniqueElement(tree,{resourceId:'com.example:id/item'}),e=>e.code==='AMBIGUOUS_ELEMENT');const ref=findElements(tree,{resourceId:'com.example:id/buy'})[0].elementRef;const changed=parseAndroidTree(initialXml.replace('Buy now','Purchase'));assert.throws(()=>findElements(changed,{elementRef:ref}),e=>e.code==='STALE_ELEMENT');
  assert.equal(findElements(tree,{resourceId:'com.example:id/item',index:1})[0].text,'Dress');
});

test('observe returns compact Snapshot with file refs and hashes while full XML stays on disk',async t=>{
  const dir=temp(t),helper=fakeHelper(dir),service=new AutomationService(helper);const snap=await service.observe({screenshot:true,tree:'full_file',runtimeSpec:true});
  assert.equal(snap.snapshotVersion,1);assert.equal(snap.device.model,'Fake Phone');assert.equal(snap.app.packageName,'com.example.test');assert.match(snap.screen.treeHash,/^[a-f0-9]{64}$/);assert.ok(snap.elements.length>0);
  assert.match(snap.screenshot.sha256,/^[a-f0-9]{64}$/);assert.equal(snap.screenshot.width,1080);assert.equal(snap.screenshot.height,2400);assert.ok(snap.pageXml.path.endsWith('.xml'));assert.equal(snap.runtimeSpec,null);assert.equal(snap.runtimeSpecError.code,'RUNTIME_SPEC_UNAVAILABLE');
  const response=JSON.stringify(snap);assert.equal(response.includes('<?xml'),false);const xmlFile=snap.pageXml.path.startsWith('~')?path.join(os.homedir(),snap.pageXml.path.slice(2)):snap.pageXml.path;assert.match(fs.readFileSync(xmlFile,'utf8'),/Buy now/);assert.equal(fs.statSync(xmlFile).mode&0o777,0o600);
});

test('find_elements refuses ambiguous results and RuntimeSpec is explicitly unavailable',async t=>{
  const service=new AutomationService(fakeHelper(temp(t)));await assert.rejects(()=>service.findElements({selector:{resourceId:'com.example:id/item'}}),e=>e.code==='AMBIGUOUS_ELEMENT');await assert.rejects(()=>service.getRuntimeSpec(),e=>e.code==='RUNTIME_SPEC_UNAVAILABLE');
});

test('AI status bar action exposes explicit notification, quick-settings and collapse operations', async t=>{
  const dir=temp(t),helper=fakeHelper(dir),service=new AutomationService(helper),lease=service.acquireControl({owner:'codex'});
  for (const [action, command] of [['notifications','expand-notifications'],['quick_settings','expand-settings'],['collapse','collapse']]) {
    const result=await service.statusBar({leaseId:lease.leaseId,action},{owner:'codex',includeTransition:false});
    assert.equal(result.action,action);const call=helper.calls.filter(item=>item.adb).at(-1);assert.equal(call.adb.at(-1),command);assert.deepEqual(call.adb.slice(0,5),['-s','SERIAL-PRIVATE','shell','cmd','statusbar']);
  }
  await assert.rejects(()=>service.statusBar({leaseId:lease.leaseId,action:'toggle'}),e=>e.code==='INVALID_SELECTOR');
});

test('AI actions require lease, invalidate cached Snapshot and never log input text',async t=>{
  const dir=temp(t),helper=fakeHelper(dir),service=new AutomationService(helper);await service.observe({tree:'summary'});assert.ok(service.snapshotCache);await assert.rejects(()=>service.tap({selector:{resourceId:'com.example:id/buy'}}),e=>e.code==='LEASE_REQUIRED');
  const lease=service.acquireControl({owner:'codex'});await service.tap({selector:{resourceId:'com.example:id/buy'},leaseId:lease.leaseId});assert.equal(service.snapshotCache,null);
  const secretText='my-private-input-93847';await service.inputText({selector:{resourceId:'com.example:id/search'},text:secretText,leaseId:lease.leaseId});assert.equal(helper.knownSecrets.includes(secretText),true);
  const audit=fs.readdirSync(path.join(dir,'ai','audit')).map(f=>fs.readFileSync(path.join(dir,'ai','audit',f),'utf8')).join('\n');assert.equal(audit.includes(secretText),false);assert.match(audit,/"characters":22/);
});

test('human drag rounds fractional browser duration before W3C actions reach UiAutomator2', async t=>{
  const helper=fakeHelper(temp(t)),service=new AutomationService(helper);
  await service.humanAction('drag',{from:{x:.25,y:.6},to:{x:.75,y:.6},durationMs:357.90000009536743});
  const action=helper.calls.find(call=>call.route?.endsWith('/actions')&&call.method==='POST');
  const duration=action?.body?.actions?.[0]?.actions?.find(item=>item.type==='pointerMove'&&item.duration>0)?.duration;
  assert.equal(duration,358);assert.equal(Number.isInteger(duration),true);
});

test('wait_for succeeds, times out and honors cancellation',async t=>{
  const helper=fakeHelper(temp(t)),service=new AutomationService(helper);const found=await service.waitFor({selector:{resourceId:'com.example:id/buy'},state:'visible',timeoutMs:500});assert.equal(found.matched,true);
  await assert.rejects(()=>service.waitFor({text:'never-there',timeoutMs:260,pollMs:120}),e=>e.code==='WAIT_TIMEOUT');
  const controller=new AbortController();setTimeout(()=>controller.abort(),30);await assert.rejects(()=>service.waitFor({text:'never-there',timeoutMs:3000,pollMs:120},controller.signal),e=>e.code==='WAIT_TIMEOUT');
});

test('checkpoint writes raw PNG, XML, Snapshot and manifest with hashes and private permissions',async t=>{
  const dir=temp(t),service=new AutomationService(fakeHelper(dir));const saved=await service.checkpoint({name:'示例页面'});assert.ok(saved.directory);const actual=saved.directory.startsWith('~')?path.join(os.homedir(),saved.directory.slice(2)):saved.directory;for(const file of ['screen.png','page.xml','snapshot.json','manifest.json']){const target=path.join(actual,file);assert.equal(fs.existsSync(target),true);assert.equal(fs.statSync(target).mode&0o777,0o600);}const manifest=JSON.parse(fs.readFileSync(path.join(actual,'manifest.json'),'utf8'));assert.match(manifest.files.screenshot.sha256,/^[a-f0-9]{64}$/);assert.match(manifest.files.page.sha256,/^[a-f0-9]{64}$/);
});

test('service and IPC reuse the existing helper session and never create a second Appium session',async t=>{
  const dir=temp(t),helper=fakeHelper(dir),session=helper.session,service=new AutomationService(helper),ipc=new AutomationIpcServer(service,dir);await ipc.start();t.after(()=>ipc.close());const result=await ipcCall('observe',{tree:'summary'},{root:dir});assert.equal(result.device.model,'Fake Phone');assert.equal(helper.session,session);assert.equal(helper.calls.some(c=>/session$|session\//.test(c.route||'')&&c.method==='POST'&&c.body?.capabilities),false);
});

// Human UI lease integration

test('browser control status exposes AI owner without leaseId, blocks manual writes, and takeover restores human control',async t=>{
  const dir=temp(t),helper=fakeHelper(dir),service=new AutomationService(helper),lease=service.acquireControl({owner:'codex'});assert.ok(lease.leaseId);const server=await startControlServer(helper,{automationService:service,screenshotRoot:dir});t.after(()=>server.close());const u=new URL(server.url),token=u.hash.slice(1),headers={'X-AndroidLink-Token':token,'Content-Type':'application/json'};
  const stat=await fetch(server.origin+'/api/status',{headers:{'X-AndroidLink-Token':token}}).then(r=>r.json());assert.equal(stat.aiControl.owner,'codex');assert.equal(stat.aiControl.leaseId,undefined);
  const blocked=await fetch(server.origin+'/api/home',{method:'POST',headers,body:'{}'});assert.equal(blocked.status,409);assert.match((await blocked.json()).error,/AI 正在控制/);
  const takeover=await fetch(server.origin+'/api/takeover',{method:'POST',headers,body:'{}'});assert.equal(takeover.status,200);const home=await fetch(server.origin+'/api/home',{method:'POST',headers,body:'{}'});assert.equal(home.status,200);assert.equal(service.leaseState().active,false);
});

// CLI / MCP entrypoints

test('CLI emits only JSON on stdout for machine calls and stable ASSISTANT_NOT_RUNNING error',async t=>{
  const dir=temp(t),service=new AutomationService(fakeHelper(dir)),ipc=new AutomationIpcServer(service,dir);await ipc.start();const cli=path.join(resources,'cli.mjs');const ok=await spawnNode(cli,['status','--json'],{ANDROID_LINK_ROOT:dir});assert.equal(ok.code,0);assert.equal(ok.stderr,'');const parsed=JSON.parse(ok.stdout.trim());assert.equal(parsed.ok,true);assert.equal(parsed.result.device.model,'Fake Phone');await ipc.close();
  const missing=temp(t,'android-ai-missing-');const fail=await spawnNode(cli,['status','--json'],{ANDROID_LINK_ROOT:missing});assert.equal(fail.code,3);const error=JSON.parse(fail.stdout.trim());assert.equal(error.error.code,'ASSISTANT_NOT_RUNNING');assert.equal(fail.stderr,'');
});

test('CLI --help works without a value and documents private install path',async()=>{const result=await spawnNode(path.join(resources,'cli.mjs'),['--help']);assert.equal(result.code,0);assert.match(result.stdout,/AI CLI/);assert.match(result.stdout,/Application Support\/AndroidLink\/bin\/android-link/);assert.equal(result.stderr,'');});

test('MCP stdio entry matches official v2 synchronous handle semantics, keeps protocol on stdout and calls the same IPC status',async t=>{
  const dir=temp(t),service=new AutomationService(fakeHelper(dir)),ipc=new AutomationIpcServer(service,dir);await ipc.start();t.after(()=>ipc.close());const packageRoot=path.join(dir,'stack','server'),sdkRoot=path.join(packageRoot,'node_modules','@modelcontextprotocol','server');fs.mkdirSync(sdkRoot,{recursive:true});
  fs.writeFileSync(path.join(packageRoot,'package.json'),'{"name":"androidlink-test-runtime","private":true,"type":"module"}');
  fs.writeFileSync(path.join(sdkRoot,'package.json'),JSON.stringify({name:'@modelcontextprotocol/server',version:'2.0.0',type:'module',exports:{'.':'./index.js','./stdio':'./stdio.js'}}));
  fs.writeFileSync(path.join(sdkRoot,'index.js'),`export class McpServer{constructor(){this.tools=new Map()}registerTool(n,c,h){this.tools.set(n,{c,h})}};export const fromJsonSchema=x=>x;`);
  fs.writeFileSync(path.join(sdkRoot,'stdio.js'),`export function serveStdio(factory){const s=factory();const item=s.tools.get('android_status');void item.h({}).then(r=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',tools:[...s.tools.keys()],status:r.structuredContent})+'\\n'));return {close:async()=>{}}}`);
  const result=await spawnNode(path.join(resources,'mcp-server.mjs'),[],{ANDROID_LINK_ROOT:dir});assert.equal(result.code,0);const lines=result.stdout.trim().split(/\n+/);assert.equal(lines.length,1);const protocol=JSON.parse(lines[0]);assert.equal(protocol.jsonrpc,'2.0');assert.ok(protocol.tools.includes('android_status'));assert.ok(protocol.tools.includes('android_checkpoint'));assert.equal(protocol.status.device.model,'Fake Phone');assert.doesNotMatch(result.stdout,/running on stdio|TypeError|\.catch/);assert.match(result.stderr,/running on stdio/);
});

test('qaId selector is deterministic when a provider enriches the current parsed tree',()=>{
  const tree=parseAndroidTree(initialXml);
  tree.elements[1].qaId='product.buy_button';
  tree.elements[0].qaId='product.container';
  const found=findElements(tree,{qaId:'product.buy_button',within:{qaId:'product.container'}});
  assert.equal(found.length,1);
  assert.equal(found[0].resourceId,'com.example:id/buy');
});

test('disconnected phone returns stable DEVICE_NOT_CONNECTED through service, IPC and CLI',async t=>{
  const dir=temp(t),service=new AutomationService(fakeHelper(dir,{connected:false}));
  await assert.rejects(()=>service.observe({tree:'summary'}),e=>e.code==='DEVICE_NOT_CONNECTED'&&e.retryable===true);assert.throws(()=>service.acquireControl({owner:'codex'}),e=>e.code==='DEVICE_NOT_CONNECTED');
  const ipc=new AutomationIpcServer(service,dir);await ipc.start();t.after(()=>ipc.close());
  await assert.rejects(()=>ipcCall('observe',{tree:'summary'},{root:dir}),e=>e.code==='DEVICE_NOT_CONNECTED');
  const result=await spawnNode(path.join(resources,'cli.mjs'),['observe','--tree','summary','--json'],{ANDROID_LINK_ROOT:dir});
  assert.equal(result.code,4);assert.equal(result.stderr,'');const parsed=JSON.parse(result.stdout.trim());assert.equal(parsed.error.code,'DEVICE_NOT_CONNECTED');
});

test('IPC startup refuses unsafe stale symlink paths without deleting their targets',async t=>{
  const dir=temp(t),ipcDir=path.join(dir,'ipc');fs.mkdirSync(ipcDir,{recursive:true,mode:0o700});
  const target=path.join(dir,'do-not-delete.txt');fs.writeFileSync(target,'keep-me');
  fs.symlinkSync(target,path.join(ipcDir,'assistant.sock'));
  const ipc=new AutomationIpcServer({dispatch:async()=>({ok:true})},dir);
  await assert.rejects(()=>ipc.start(),/IPC socket 路径异常/);
  assert.equal(fs.readFileSync(target,'utf8'),'keep-me');assert.equal(fs.lstatSync(path.join(ipcDir,'assistant.sock')).isSymbolicLink(),true);
});

test('AI disconnect runs shared control cleanup hook and closes the existing helper session',async t=>{
  const dir=temp(t),helper=fakeHelper(dir),service=new AutomationService(helper);let before=0,after=0;
  service.setHooks({beforeDisconnect:async()=>{before++;},afterDisconnect:async()=>{after++;}});
  const lease=service.acquireControl({owner:'codex'});const result=await service.disconnect({leaseId:lease.leaseId});
  assert.equal(result.connected,false);assert.equal(before,1);assert.equal(after,1);assert.equal(helper.session,null);
  assert.equal(helper.calls.some(c=>c.method==='POST'&&c.body?.capabilities),false);
});


test('IPC rejects reusing the same requestId for a different payload instead of returning a stale cached result', async t=>{
  const dir=temp(t);let calls=0;const ipc=new AutomationIpcServer({dispatch:async()=>({calls:++calls})},dir);await ipc.start();t.after(()=>ipc.close());
  const requestId='collision-request-0001';await ipcCall('tap',{leaseId:'same',point:{x:.2,y:.2}},{root:dir,requestId});
  await assert.rejects(()=>ipcCall('tap',{leaseId:'same',point:{x:.8,y:.8}},{root:dir,requestId}),e=>e.code==='INTERNAL_ERROR'&&/requestId/.test(e.message));
  assert.equal(calls,1);
});

test('IPC action timeout aborts the underlying Appium request so a stale tap cannot execute later', async t=>{
  const dir=temp(t),helper=fakeHelper(dir);let aborted=false,completed=false;
  helper.http=async(base,route,method='GET',body,timeout,signal)=>{
    helper.calls.push({route,method,body});
    if(route.endsWith('/execute/sync')&&body?.script==='mobile: clickGesture') return await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{completed=true;resolve(null);},500);
      signal?.addEventListener('abort',()=>{aborted=true;clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));},{once:true});
    });
    if(route.endsWith('/source')) return initialXml;
    if(route.endsWith('/appium/device/current_package')) return 'com.example.test';
    if(route.endsWith('/appium/device/current_activity')) return '.MainActivity';
    return null;
  };
  const service=new AutomationService(helper),lease=service.acquireControl({owner:'codex'}),ipc=new AutomationIpcServer(service,dir,{actionTimeoutMs:45});await ipc.start();t.after(()=>ipc.close());
  await assert.rejects(()=>ipcCall('tap',{leaseId:lease.leaseId,point:{x:.5,y:.5}},{root:dir,timeoutMs:1000}),e=>e.code==='ACTION_TIMEOUT');
  await new Promise(r=>setTimeout(r,100));assert.equal(aborted,true);assert.equal(completed,false);
});

test('control action preempts an in-flight background page-tree read instead of waiting behind it', async t=>{
  const dir=temp(t),helper=fakeHelper(dir);let sourceCalls=0,firstSourceAborted=false,clickAt=0;
  helper.http=async(base,route,method='GET',body,timeout,signal)=>{
    helper.calls.push({route,method,body});
    if(route.endsWith('/source')){
      sourceCalls++;
      if(sourceCalls===1) return await new Promise((resolve,reject)=>signal?.addEventListener('abort',()=>{firstSourceAborted=true;reject(new DOMException('Aborted','AbortError'));},{once:true}));
      return initialXml;
    }
    if(route.endsWith('/execute/sync')&&body?.script==='mobile: clickGesture'){clickAt=Date.now();return null;}
    if(route.endsWith('/appium/device/current_package')) return 'com.example.test';
    if(route.endsWith('/appium/device/current_activity')) return '.MainActivity';
    return null;
  };
  const service=new AutomationService(helper),observe=service.observe({tree:'summary'}).catch(e=>e);await new Promise(r=>setTimeout(r,20));
  const lease=service.acquireControl({owner:'codex'}),started=Date.now();const tapped=await service.tap({leaseId:lease.leaseId,point:{x:.5,y:.5}},{owner:'codex',includeTransition:true});
  assert.equal(firstSourceAborted,true);assert.ok(clickAt-started<150,`tap waited ${clickAt-started}ms behind observe`);assert.ok(tapped.durationMs<1800);assert.equal((await observe).code,'ACTION_TIMEOUT');
});

test('human direct-touch remains blocked after takeover until the active AI action actually finishes', async()=>{
  const lease=new ControlLeaseManager(),acquired=lease.acquire('codex');let releaseAction;
  const action=lease.withWriter({kind:'action',owner:'codex',leaseId:acquired.leaseId},()=>new Promise(r=>releaseAction=r));
  await new Promise(r=>setTimeout(r,5));const takeover=lease.takeoverByHuman();assert.equal(takeover.previousOwner,'codex');
  assert.throws(()=>lease.assertHumanCanWrite(),e=>e.code==='LEASE_CONFLICT'&&/仍在执行/.test(e.message));
  releaseAction({ok:true});await action;assert.doesNotThrow(()=>lease.assertHumanCanWrite());
});

test('nested within selector applies the parent index deterministically',()=>{
  const xml=`<hierarchy><node resource-id="container" bounds="[0,0][100,100]"><node resource-id="child" text="first" displayed="true" bounds="[0,0][50,50]"/></node><node resource-id="container" bounds="[0,100][100,200]"><node resource-id="child" text="second" displayed="true" bounds="[0,100][50,150]"/></node></hierarchy>`;
  const tree=parseAndroidTree(xml),found=findElements(tree,{resourceId:'child',within:{resourceId:'container',index:1}});assert.equal(found.length,1);assert.equal(found[0].text,'second');
});

test('launch_app preserves the control lease and reaches the shared Appium lifecycle path', async t=>{
  const dir=temp(t),helper=fakeHelper(dir);const original=helper.http;
  helper.http=async(base,route,method,body,timeout,signal)=>{if(route.endsWith('/execute/sync')&&body?.script==='mobile: queryAppState'){helper.calls.push({route,method,body});return 4;}return original(base,route,method,body,timeout,signal);};
  const service=new AutomationService(helper),lease=service.acquireControl({owner:'codex'});const result=await service.launchApp({leaseId:lease.leaseId,packageName:'com.example.test'},{owner:'codex',includeTransition:false});
  assert.equal(result.packageName,'com.example.test');assert.ok(helper.calls.some(c=>c.body?.script==='mobile: activateApp'));
});

test('transient observe artifacts are bounded while checkpoint evidence remains outside the pruning pool', async t=>{
  const dir=temp(t),service=new AutomationService(fakeHelper(dir));let latest;
  for(let i=0;i<126;i++) latest=await service.observe({screenshot:true,tree:'none'});
  const shotDir=path.join(dir,'ai','artifacts','screenshots'),files=fs.readdirSync(shotDir);assert.ok(files.length<=120);const latestPath=latest.screenshot.path.startsWith('~')?path.join(os.homedir(),latest.screenshot.path.slice(2)):latest.screenshot.path;assert.equal(fs.existsSync(latestPath),true);
  const checkpoint=await service.checkpoint({name:'persistent'});const cp=checkpoint.directory.startsWith('~')?path.join(os.homedir(),checkpoint.directory.slice(2)):checkpoint.directory;assert.equal(fs.existsSync(path.join(cp,'screen.png')),true);
});

test('browser direct-touch route cannot slip through while an AI action is finishing after human takeover', async t=>{
  const dir=temp(t),helper=fakeHelper(dir),service=new AutomationService(helper),lease=service.acquireControl({owner:'codex'});let releaseAction;
  const active=service.lease.withWriter({kind:'action',owner:'codex',leaseId:lease.leaseId},()=>new Promise(r=>releaseAction=r));
  await new Promise(r=>setTimeout(r,5));const server=await startControlServer(helper,{automationService:service,screenshotRoot:dir});t.after(()=>server.close());
  const u=new URL(server.url),token=u.hash.slice(1),headers={'X-AndroidLink-Token':token,'Content-Type':'application/json'};
  const takeover=await fetch(server.origin+'/api/takeover',{method:'POST',headers,body:'{}'});assert.equal(takeover.status,200);
  const touch=await fetch(server.origin+'/api/touch',{method:'POST',headers,body:JSON.stringify({action:'down',x:.5,y:.5})});assert.equal(touch.status,409);assert.match((await touch.json()).error,/仍在执行/);
  releaseAction({ok:true});await active;
});
