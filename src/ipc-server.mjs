import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {AutomationError} from './automation-errors.mjs';
import {AUTOMATION_PROTOCOL_VERSION, IPC_MAX_REQUEST_BYTES, IPC_MAX_RESPONSE_BYTES, validateRequest, successResponse, failureResponse, encodeMessage} from './automation-protocol.mjs';

const CACHE_TTL_MS = 120000;
const ACTION_METHODS = new Set(['tap','swipe','drag','input_text','press_key','launch_app','disconnect']);

function secureDirectory(directory) {
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const info=fs.lstatSync(directory);
  if(!info.isDirectory()||info.isSymbolicLink()) throw new Error('IPC 目录不安全。');
  fs.chmodSync(directory,0o700);
}
function ownedByCurrentUser(info) { return typeof process.getuid !== 'function' || info.uid === process.getuid(); }
async function socketAlive(socketPath) {
  return await new Promise(resolve=>{
    const socket=net.createConnection(socketPath);let settled=false;
    const done=value=>{if(settled)return;settled=true;socket.destroy();resolve(value);};
    socket.once('connect',()=>done(true));socket.once('error',()=>done(false));setTimeout(()=>done(false),250).unref?.();
  });
}
function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
}
function requestFingerprint(request) {
  return crypto.createHash('sha256').update(request.method + '\n' + stableJson(request.params || {})).digest('hex');
}

export class AutomationIpcServer {
  constructor(service, root, options={}) {
    this.service=service;this.root=root;this.ipcDir=options.ipcDir||path.join(root,'ipc');this.socketPath=options.socketPath||path.join(this.ipcDir,'assistant.sock');
    this.secretPath=options.secretPath||path.join(this.ipcDir,'assistant.secret');this.server=null;this.secret=null;this.cache=new Map();this.sockets=new Set();
    this.timeouts={read:Math.max(100,Number(options.readTimeoutMs)||20000),action:Math.max(100,Number(options.actionTimeoutMs)||30000),wait:Math.max(250,Number(options.waitTimeoutMs)||125000),checkpoint:Math.max(250,Number(options.checkpointTimeoutMs)||65000)};
  }
  async start() {
    secureDirectory(this.ipcDir);
    if(fs.existsSync(this.socketPath)){
      const info=fs.lstatSync(this.socketPath);
      if(info.isSymbolicLink()||!info.isSocket()||!ownedByCurrentUser(info)) throw new Error('IPC socket 路径异常，未自动删除。');
      if(await socketAlive(this.socketPath)) throw new Error('已有安卓连接助手 IPC 正在运行。');
      fs.unlinkSync(this.socketPath);
    }
    if(fs.existsSync(this.secretPath)){
      const info=fs.lstatSync(this.secretPath);
      if(info.isSymbolicLink()||!info.isFile()||!ownedByCurrentUser(info)) throw new Error('IPC secret 路径异常，未自动覆盖。');
      fs.unlinkSync(this.secretPath);
    }
    this.secret=crypto.randomBytes(32).toString('hex');fs.writeFileSync(this.secretPath,this.secret+'\n',{flag:'wx',mode:0o600});fs.chmodSync(this.secretPath,0o600);
    this.server=net.createServer(socket=>{this.sockets.add(socket);socket.once('close',()=>this.sockets.delete(socket));this.#handleSocket(socket);});this.server.maxConnections=32;
    await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.socketPath,resolve);});
    fs.chmodSync(this.socketPath,0o600);
    return {socketPath:this.socketPath,protocolVersion:AUTOMATION_PROTOCOL_VERSION};
  }
  async close() {
    const server=this.server;this.server=null;
    if(server){for(const socket of this.sockets)socket.destroy();this.sockets.clear();await new Promise(resolve=>server.close(()=>resolve()));}
    for(const file of [this.socketPath,this.secretPath]){
      try{const info=fs.lstatSync(file);if(!info.isSymbolicLink()&&ownedByCurrentUser(info))fs.unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}
    }
    this.secret=null;this.cache.clear();
  }
  #auth(value){
    if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value)||!this.secret) return false;
    return crypto.timingSafeEqual(Buffer.from(value),Buffer.from(this.secret));
  }
  #cleanCache(){const now=Date.now();for(const [key,value] of this.cache)if(now-value.at>CACHE_TTL_MS)this.cache.delete(key);}
  #handleSocket(socket){
    socket.setNoDelay(true);socket.setTimeout(130000);let bytes=0,buffer='',finished=false;const connectionController=new AbortController();
    const finish=response=>{if(finished)return;finished=true;try{socket.end(encodeMessage(response,IPC_MAX_RESPONSE_BYTES));}catch{socket.destroy();}};
    socket.on('data',chunk=>{
      if(finished)return;bytes+=chunk.length;if(bytes>IPC_MAX_REQUEST_BYTES){finish(failureResponse('invalid-request',new AutomationError('RATE_LIMITED','IPC 请求过大。')));return;}
      buffer+=chunk.toString('utf8');const newline=buffer.indexOf('\n');if(newline<0)return;
      const line=buffer.slice(0,newline);if(buffer.slice(newline+1).trim()){finish(failureResponse('invalid-request',new AutomationError('INTERNAL_ERROR','一次 IPC 连接只允许一个请求。')));return;}
      this.#process(line,connectionController).then(finish).catch(error=>finish(failureResponse('invalid-request',error)));
    });
    socket.on('timeout',()=>{connectionController.abort('socket-timeout');socket.destroy();});
    socket.on('close',()=>connectionController.abort('client-closed'));
    socket.on('error',()=>{});
  }
  async #process(line,connectionController){
    let raw;try{raw=JSON.parse(line);}catch{return failureResponse('invalid-request',new AutomationError('INTERNAL_ERROR','IPC JSON 无法解析。'));}
    let req;try{req=validateRequest(raw);}catch(error){return failureResponse(raw?.requestId,error);}
    if(!this.#auth(req.auth)) return failureResponse(req.requestId,new AutomationError('AUTH_FAILED'));
    this.#cleanCache();
    const fingerprint=requestFingerprint(req),cached=this.cache.get(req.requestId);
    if(cached){
      if(cached.fingerprint!==fingerprint) return failureResponse(req.requestId,new AutomationError('INTERNAL_ERROR','requestId 已用于不同请求，拒绝复用。',{retryable:false}));
      return cached.response;
    }
    const operationController=new AbortController();
    const signal=AbortSignal.any([connectionController.signal,operationController.signal]);
    const run=async()=>await this.service.dispatch(req.method,req.params,{signal,owner:req.params?.owner||'AI',includeTransition:ACTION_METHODS.has(req.method)});
    const timeoutMs=req.method==='wait_for'?this.timeouts.wait:req.method==='checkpoint'?this.timeouts.checkpoint:ACTION_METHODS.has(req.method)?this.timeouts.action:this.timeouts.read;
    const timeoutError=new AutomationError(req.method==='wait_for'?'WAIT_TIMEOUT':'ACTION_TIMEOUT',undefined,{retryable:true});
    let timer;try{
      const result=await Promise.race([run(),new Promise((_,reject)=>{timer=setTimeout(()=>{operationController.abort('ipc-operation-timeout');reject(timeoutError);},timeoutMs);})]);
      const response=successResponse(req.requestId,result);this.cache.set(req.requestId,{at:Date.now(),fingerprint,response});return response;
    }catch(error){const response=failureResponse(req.requestId,error);this.cache.set(req.requestId,{at:Date.now(),fingerprint,response});return response;}
    finally{clearTimeout(timer);}
  }
}
