import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';

const MANAGED_BEGIN = '# BEGIN AndroidLink MCP (managed by 安卓连接助手)';
const MANAGED_END = '# END AndroidLink MCP (managed by 安卓连接助手)';
const SERVER_NAME = 'android-link';

function homePath(...parts) { return path.join(os.homedir(), ...parts); }
function exists(target) { try { return fs.existsSync(target); } catch { return false; } }
function ensurePrivateDir(target) { fs.mkdirSync(target, {recursive:true, mode:0o700}); try { fs.chmodSync(target, 0o700); } catch {} }
function atomicWrite(file, text) {
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, {mode:0o600});
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, file);
}
function pathCommand(name) {
  const candidates = String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name));
  for (const candidate of candidates) { try { if (fs.statSync(candidate).isFile()) return candidate; } catch {} }
  return null;
}

export function mcpLaunchSpec() {
  return Object.freeze({
    command:'/bin/zsh',
    args:Object.freeze(['-f','-c','exec "$HOME/Library/Application Support/AndroidLink/bin/android-link-mcp"']),
  });
}

export function mcpConfigSnippets() {
  const spec = mcpLaunchSpec();
  const json = JSON.stringify({mcpServers:{[SERVER_NAME]:{command:spec.command,args:[...spec.args]}}}, null, 2);
  const toml = `[mcp_servers.${SERVER_NAME}]\ncommand = ${JSON.stringify(spec.command)}\nargs = [${spec.args.map(value=>JSON.stringify(value)).join(', ')}]\nenabled = true\n`;
  const command = `${spec.command} ${spec.args.map(value=>JSON.stringify(value)).join(' ')}`;
  return {serverName:SERVER_NAME, transport:'stdio', json, toml, command,
    launcher:'~/Library/Application Support/AndroidLink/bin/android-link-mcp'};
}

function codexConfigPath() { return homePath('.codex','config.toml'); }
function cursorConfigPath() { return homePath('.cursor','mcp.json'); }
function codexManagedBlock() {
  const spec = mcpLaunchSpec();
  return `${MANAGED_BEGIN}\n[mcp_servers.${SERVER_NAME}]\ncommand = ${JSON.stringify(spec.command)}\nargs = [${spec.args.map(value=>JSON.stringify(value)).join(', ')}]\nenabled = true\n${MANAGED_END}`;
}
function stripManagedBlock(text) {
  const start = text.indexOf(MANAGED_BEGIN), end = text.indexOf(MANAGED_END);
  if (start < 0 || end < start) return {text, removed:false};
  const after = end + MANAGED_END.length;
  const merged = (text.slice(0,start).replace(/[ \t]+$/gm,'').replace(/\n{3,}$/,'\n\n') + text.slice(after)).replace(/^\n+|\n+$/g,'');
  return {text: merged ? merged + '\n' : '', removed:true};
}
function codexState() {
  const config = codexConfigPath();
  const text = exists(config) ? fs.readFileSync(config,'utf8') : '';
  const managed = text.includes(MANAGED_BEGIN) && text.includes(MANAGED_END);
  const configured = managed || /^\s*\[mcp_servers\.android-link\]\s*$/m.test(text);
  const app = ['/Applications/Codex.app',homePath('Applications','Codex.app')].find(exists) || null;
  const cli = pathCommand('codex') || ['/opt/homebrew/bin/codex','/usr/local/bin/codex',homePath('.local','bin','codex')].find(exists) || null;
  return {id:'codex',name:'Codex',detected:Boolean(app||cli||exists(homePath('.codex'))),oneClick:true,configured,managed,
    detail:configured?(managed?'已由安卓连接助手接入':'已存在 android-link 配置'):(app||cli?'已检测到':'未检测到'),configPath:'~/.codex/config.toml'};
}
function cursorEntryState(entry) {
  if (!entry || typeof entry !== 'object') return {configured:false,managed:false};
  const spec = mcpLaunchSpec();
  const configured = entry.command === spec.command && Array.isArray(entry.args) && entry.args.join('\u0000') === spec.args.join('\u0000');
  const managed = configured && entry.env?.ANDROID_LINK_MANAGED === '1';
  return {configured,managed};
}
function cursorState() {
  const config = cursorConfigPath(); let parsed = null, malformed = false;
  if (exists(config)) { try { parsed = JSON.parse(fs.readFileSync(config,'utf8')); } catch { malformed = true; } }
  const entry = parsed?.mcpServers?.[SERVER_NAME]; const state = cursorEntryState(entry);
  const app = ['/Applications/Cursor.app',homePath('Applications','Cursor.app')].find(exists) || null;
  const cli = pathCommand('cursor') || null;
  return {id:'cursor',name:'Cursor',detected:Boolean(app||cli||exists(homePath('.cursor'))),oneClick:!malformed,configured:state.configured,managed:state.managed,
    detail:malformed?'mcp.json 无法解析，请手动检查':state.configured?(state.managed?'已由安卓连接助手接入':'已存在 android-link 配置'):(app||cli?'已检测到':'未检测到'),configPath:'~/.cursor/mcp.json',malformed};
}
function claudeState() {
  const app = ['/Applications/Claude.app',homePath('Applications','Claude.app')].find(exists) || null;
  return {id:'claude',name:'Claude Desktop',detected:Boolean(app),oneClick:false,configured:false,managed:false,
    detail:app?'已检测到 · 使用下方手动 MCP 配置':'未检测到',configPath:null};
}

export function detectAiIntegrations() {
  return {clients:[codexState(),cursorState(),claudeState()], snippets:mcpConfigSnippets(), checkedAt:new Date().toISOString()};
}

export function connectAiClient(clientId) {
  if (clientId === 'codex') {
    const state = codexState();
    if (!state.detected) throw new Error('未检测到 Codex。可使用“复制 MCP 配置”手动接入。');
    if (state.configured) return {ok:true,client:'codex',changed:false,state};
    const file = codexConfigPath(); const existing = exists(file) ? fs.readFileSync(file,'utf8') : '';
    const clean = stripManagedBlock(existing).text.replace(/\s+$/,'');
    atomicWrite(file, `${clean}${clean?'\n\n':''}${codexManagedBlock()}\n`);
    return {ok:true,client:'codex',changed:true,state:codexState(),restartHint:'重新打开 Codex 会话后生效。'};
  }
  if (clientId === 'cursor') {
    const state = cursorState();
    if (!state.detected) throw new Error('未检测到 Cursor。可使用“复制 MCP 配置”手动接入。');
    if (state.malformed) throw new Error('~/.cursor/mcp.json 不是有效 JSON，为避免覆盖现有配置，已停止自动接入。');
    if (state.configured) return {ok:true,client:'cursor',changed:false,state};
    const file = cursorConfigPath(); let doc = {};
    if (exists(file)) doc = JSON.parse(fs.readFileSync(file,'utf8'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('Cursor MCP 配置格式异常，未修改。');
    doc.mcpServers = doc.mcpServers && typeof doc.mcpServers === 'object' && !Array.isArray(doc.mcpServers) ? doc.mcpServers : {};
    if (doc.mcpServers[SERVER_NAME]) throw new Error('Cursor 已存在名为 android-link 的其他配置，为避免覆盖请手动处理。');
    const spec = mcpLaunchSpec(); doc.mcpServers[SERVER_NAME] = {command:spec.command,args:[...spec.args],env:{ANDROID_LINK_MANAGED:'1'}};
    atomicWrite(file, JSON.stringify(doc,null,2)+'\n');
    return {ok:true,client:'cursor',changed:true,state:cursorState(),restartHint:'重新打开 Cursor 会话后生效。'};
  }
  throw new Error('这个 AI 暂不支持自动写入配置，请复制 MCP 配置后手动接入。');
}

export function removeAiClient(clientId) {
  if (clientId === 'codex') {
    const file = codexConfigPath(); if (!exists(file)) return {ok:true,client:'codex',changed:false,state:codexState()};
    const current = fs.readFileSync(file,'utf8'); const stripped = stripManagedBlock(current);
    if (!stripped.removed) throw new Error('当前 Codex 的 android-link 配置不是由安卓连接助手写入，未自动删除。');
    atomicWrite(file,stripped.text); return {ok:true,client:'codex',changed:true,state:codexState(),restartHint:'重新打开 Codex 会话后生效。'};
  }
  if (clientId === 'cursor') {
    const file = cursorConfigPath(); if (!exists(file)) return {ok:true,client:'cursor',changed:false,state:cursorState()};
    let doc; try { doc=JSON.parse(fs.readFileSync(file,'utf8')); } catch { throw new Error('Cursor MCP 配置无法解析，未自动修改。'); }
    const entry=doc?.mcpServers?.[SERVER_NAME], state=cursorEntryState(entry);
    if (!state.managed) throw new Error('当前 Cursor 的 android-link 配置不是由安卓连接助手写入，未自动删除。');
    delete doc.mcpServers[SERVER_NAME]; atomicWrite(file,JSON.stringify(doc,null,2)+'\n');
    return {ok:true,client:'cursor',changed:true,state:cursorState(),restartHint:'重新打开 Cursor 会话后生效。'};
  }
  throw new Error('这个 AI 没有由安卓连接助手管理的配置。');
}

export async function testMcpHealth(root, options={}) {
  const launcher = path.join(root,'bin','android-link-mcp');
  if (!exists(launcher)) throw new Error('MCP 启动器尚未安装，请重新运行安卓连接助手安装器。');
  const timeoutMs = Math.max(1000,Math.min(15000,Number(options.timeoutMs)||7000));
  return await new Promise((resolve,reject)=>{
    let stdout='',stderr='',done=false; const child=spawn(launcher,[],{env:{...process.env,ANDROID_LINK_MCP_SELF_TEST:'1'},stdio:['ignore','pipe','pipe'],shell:false});
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);if(error)reject(error);else resolve(value);};
    child.stdout.on('data',chunk=>{stdout=(stdout+chunk).slice(-65536);}); child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-65536);});
    child.on('error',error=>finish(new Error('MCP 启动失败：'+error.message)));
    child.on('close',code=>{if(done)return;if(code!==0)return finish(new Error(('MCP 自检失败：'+(stderr.trim()||`退出码 ${code}`)).slice(0,500)));try{const result=JSON.parse(stdout.trim().split(/\n+/).at(-1)||'{}');if(!result.ok||!Number.isInteger(result.toolCount)||result.toolCount<1)throw new Error('MCP 自检返回异常。');finish(null,result);}catch(error){finish(new Error('MCP 自检结果无法解析：'+error.message));}});
    const timer=setTimeout(()=>{try{child.kill('SIGTERM');}catch{}finish(new Error('MCP 自检超时。'));},timeoutMs);timer.unref?.();
  });
}
