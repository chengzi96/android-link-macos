import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import {AutomationError} from './automation-errors.mjs';
import {AUTOMATION_PROTOCOL_VERSION, IPC_MAX_RESPONSE_BYTES} from './automation-protocol.mjs';

export function defaultAndroidLinkRoot(){return process.env.ANDROID_LINK_ROOT||path.join(os.homedir(),'Library','Application Support','AndroidLink');}

function readSecret(root){
  const file=path.join(root,'ipc','assistant.secret');
  let info;try{info=fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')throw new AutomationError('ASSISTANT_NOT_RUNNING');throw error;}
  if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0||(typeof process.getuid==='function'&&info.uid!==process.getuid()))throw new AutomationError('AUTH_FAILED','IPC secret 权限异常，请重启安卓连接助手。');
  const secret=fs.readFileSync(file,'utf8').trim();if(!/^[a-f0-9]{64}$/.test(secret))throw new AutomationError('AUTH_FAILED');return secret;
}

export async function ipcCall(method,params={},options={}){
  const root=options.root||defaultAndroidLinkRoot(),socketPath=path.join(root,'ipc','assistant.sock'),secret=readSecret(root);
  try{const info=fs.lstatSync(socketPath);if(!info.isSocket()||info.isSymbolicLink()||(typeof process.getuid==='function'&&info.uid!==process.getuid()))throw new AutomationError('ASSISTANT_NOT_RUNNING');}catch(error){if(error.code==='ENOENT')throw new AutomationError('ASSISTANT_NOT_RUNNING');throw error;}
  const request={protocolVersion:AUTOMATION_PROTOCOL_VERSION,requestId:options.requestId||crypto.randomUUID(),method,params,auth:secret};
  const timeoutMs=Math.max(1000,Math.min(130000,Number(options.timeoutMs)||(method==='wait_for'?125000:30000)));
  return await new Promise((resolve,reject)=>{
    const socket=net.createConnection(socketPath);let buffer='',bytes=0,settled=false;
    const done=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(value);};
    const timer=setTimeout(()=>done(new AutomationError(method==='wait_for'?'WAIT_TIMEOUT':'ACTION_TIMEOUT',undefined,{retryable:true})),timeoutMs);
    socket.once('connect',()=>socket.write(JSON.stringify(request)+'\n'));
    socket.on('data',chunk=>{bytes+=chunk.length;if(bytes>IPC_MAX_RESPONSE_BYTES){done(new AutomationError('INTERNAL_ERROR','IPC 响应过大。'));return;}buffer+=chunk.toString('utf8');const i=buffer.indexOf('\n');if(i<0)return;let response;try{response=JSON.parse(buffer.slice(0,i));}catch{done(new AutomationError('INTERNAL_ERROR','IPC 响应无法解析。'));return;}if(response.protocolVersion!==AUTOMATION_PROTOCOL_VERSION){done(new AutomationError('PROTOCOL_VERSION_UNSUPPORTED'));return;}if(response.ok){done(null,response.result);return;}const e=response.error||{};done(new AutomationError(e.code||'INTERNAL_ERROR',e.message,{retryable:e.retryable,details:e.details}));});
    socket.once('error',error=>done(error.code==='ENOENT'||error.code==='ECONNREFUSED'?new AutomationError('ASSISTANT_NOT_RUNNING'):new AutomationError('INTERNAL_ERROR','无法连接本机工具层。')));
  });
}
