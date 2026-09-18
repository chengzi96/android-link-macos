import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {detectAiIntegrations,connectAiClient,removeAiClient,mcpConfigSnippets,testMcpHealth} from '../src/ai-integration.mjs';

function withHome(t){const old=process.env.HOME,dir=fs.mkdtempSync(path.join(os.tmpdir(),'androidlink-ai-home-'));process.env.HOME=dir;t.after(()=>{process.env.HOME=old;fs.rmSync(dir,{recursive:true,force:true});});return dir;}

test('generic MCP copy snippets cover JSON TOML and command without secrets',()=>{const x=mcpConfigSnippets();assert.equal(x.transport,'stdio');assert.match(x.json,/"mcpServers"/);assert.match(x.json,/android-link-mcp/);assert.match(x.toml,/\[mcp_servers\.android-link\]/);assert.match(x.command,/\/bin\/zsh/);assert.doesNotMatch(JSON.stringify(x),/token|assistant\.secret|ADB.*serial/i);});

test('Codex one-click integration appends and removes only the managed MCP block',t=>{const home=withHome(t),dir=path.join(home,'.codex');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'config.toml');fs.writeFileSync(file,'model = "gpt-test"\n');const before=detectAiIntegrations().clients.find(x=>x.id==='codex');assert.equal(before.detected,true);assert.equal(before.configured,false);const added=connectAiClient('codex');assert.equal(added.changed,true);const text=fs.readFileSync(file,'utf8');assert.match(text,/model = "gpt-test"/);assert.match(text,/BEGIN AndroidLink MCP/);assert.match(text,/\[mcp_servers\.android-link\]/);const removed=removeAiClient('codex');assert.equal(removed.changed,true);assert.equal(fs.readFileSync(file,'utf8').trim(),'model = "gpt-test"');});

test('Cursor one-click integration merges mcpServers and preserves unrelated servers',t=>{const home=withHome(t),dir=path.join(home,'.cursor');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'mcp.json');fs.writeFileSync(file,JSON.stringify({mcpServers:{existing:{command:'x',args:['y']}},other:true},null,2));const added=connectAiClient('cursor');assert.equal(added.changed,true);let doc=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(doc.other,true);assert.equal(doc.mcpServers.existing.command,'x');assert.equal(doc.mcpServers['android-link'].env.ANDROID_LINK_MANAGED,'1');const removed=removeAiClient('cursor');assert.equal(removed.changed,true);doc=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(doc.mcpServers.existing.command,'x');assert.equal(doc.mcpServers['android-link'],undefined);});

test('Cursor malformed JSON is never overwritten by automatic integration',t=>{const home=withHome(t),dir=path.join(home,'.cursor');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'mcp.json');fs.writeFileSync(file,'{ broken');assert.throws(()=>connectAiClient('cursor'),/不是有效 JSON|无法解析/);assert.equal(fs.readFileSync(file,'utf8'),'{ broken');});

test('MCP self-test runner validates the installed launcher response',async t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'androidlink-mcp-root-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const bin=path.join(root,'bin');fs.mkdirSync(bin,{recursive:true});const launcher=path.join(bin,'android-link-mcp');fs.writeFileSync(launcher,'#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"toolCount":16,"status":{"connected":true}}\'\n',{mode:0o700});const result=await testMcpHealth(root,{timeoutMs:2000});assert.equal(result.ok,true);assert.equal(result.toolCount,16);assert.equal(result.status.connected,true);});
