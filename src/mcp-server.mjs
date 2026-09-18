#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {ipcCall, defaultAndroidLinkRoot} from './ipc-client.mjs';
import {VERSION} from './core.mjs';

const root=defaultAndroidLinkRoot();
const runtimePackage=path.join(root,'stack','server','package.json');
let requireSdk;
try{requireSdk=createRequire(runtimePackage);}catch(error){console.error('MCP 运行环境未安装：请重新运行安卓连接助手安装器。');process.exit(2);}
let sdk,stdio;
try{
  const sdkEntry=requireSdk.resolve('@modelcontextprotocol/server');
  const stdioEntry=requireSdk.resolve('@modelcontextprotocol/server/stdio');
  [sdk,stdio]=await Promise.all([import(pathToFileURL(sdkEntry).href),import(pathToFileURL(stdioEntry).href)]);
}catch(error){console.error('MCP SDK 未就绪：请重新运行安卓连接助手安装器。');process.exit(2);}
const {McpServer,fromJsonSchema}=sdk,{serveStdio}=stdio;
if(typeof McpServer!=='function'||typeof fromJsonSchema!=='function'||typeof serveStdio!=='function'){console.error('MCP SDK API 不完整：请重新运行安卓连接助手安装器。');process.exit(2);}

const object=schema=>fromJsonSchema({type:'object',additionalProperties:false,...schema});
const textMatchSchema={oneOf:[{type:'string',maxLength:200},{type:'object',additionalProperties:false,minProperties:1,maxProperties:1,properties:{equals:{type:'string',maxLength:200},contains:{type:'string',maxLength:200},startsWith:{type:'string',maxLength:200},endsWith:{type:'string',maxLength:200}}}]};
function makeSelectorSchema(depth=0){
  const properties={elementRef:{type:'string'},qaId:{type:'string',maxLength:220},resourceId:{type:'string',maxLength:220},text:textMatchSchema,contentDescription:textMatchSchema,className:{type:'string',maxLength:220},clickable:{type:'boolean'},visible:{type:'boolean'},enabled:{type:'boolean'},index:{type:'integer',minimum:0,maximum:1000}};
  if(depth<4) properties.within=makeSelectorSchema(depth+1);
  return {type:'object',additionalProperties:false,properties};
}
const selectorSchema=makeSelectorSchema();
const relativePointSchema={type:'object',additionalProperties:false,properties:{x:{type:'number',minimum:0,maximum:1},y:{type:'number',minimum:0,maximum:1}},required:['x','y']};
function jsonResult(value){const text=JSON.stringify(value);return {content:[{type:'text',text}],structuredContent:value};}
function toolError(error){const value={ok:false,error:{code:error?.code||'INTERNAL_ERROR',message:String(error?.message||error).slice(0,400),retryable:Boolean(error?.retryable),details:error?.details||{}}};return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,isError:true};}
function register(server,name,description,schema,method,mapper=args=>args){server.__androidLinkToolNames ||= [];server.__androidLinkToolNames.push(name);server.registerTool(name,{description,inputSchema:object(schema)},async args=>{try{return jsonResult(await ipcCall(method,mapper(args||{}),{timeoutMs:method==='wait_for'?125000:method==='checkpoint'?60000:30000}));}catch(error){return toolError(error);}});}

function createServer(){
  const server=new McpServer({name:'android-link',version:VERSION});
  register(server,'android_status','只读：返回助手版本、工具协议、连接状态、设备型号、Android 版本、当前 App 和 AI 控制租约；不返回 ADB 序列号。',{properties:{}},'status');
  register(server,'android_observe','只读：按需采集统一 Snapshot。截图和完整 XML 保存为本机受控文件引用，不把大文件或完整 XML 塞进上下文。',{properties:{screenshot:{type:'boolean',default:false},tree:{type:'string',enum:['none','summary','full_file'],default:'summary'},runtimeSpec:{type:'boolean',default:false}}},'observe');
  register(server,'android_find_elements','只读：用确定性 Selector 查找元素。多个匹配不会偷偷选择第一个，而是返回 AMBIGUOUS_ELEMENT。',{properties:{selector:selectorSchema},required:['selector']},'find_elements');
  register(server,'android_get_runtime_spec','只读：读取未来 external External Spec Provider 提供的 RuntimeSpec；未配置时明确返回 RUNTIME_SPEC_UNAVAILABLE。',{properties:{}},'get_runtime_spec');
  register(server,'android_acquire_control','获取 AI 写控制租约。所有会改变手机状态的 AI 工具都必须携带 leaseId。',{properties:{owner:{type:'string',minLength:1,maxLength:80},ttlMs:{type:'integer',minimum:5000,maximum:300000}},required:['owner']},'acquire_control');
  register(server,'android_renew_control','续租已有 AI 控制权。',{properties:{leaseId:{type:'string'},ttlMs:{type:'integer',minimum:5000,maximum:300000}},required:['leaseId']},'renew_control');
  register(server,'android_release_control','释放 AI 控制租约，让人工界面立即恢复写控制。',{properties:{leaseId:{type:'string'}},required:['leaseId']},'release_control');
  register(server,'android_tap','写操作：用唯一 Selector 点击元素中心；也允许调用方明确提供 0–1 相对坐标作为后备。返回动作前后页面摘要/hash 和耗时。',{properties:{leaseId:{type:'string'},selector:selectorSchema,point:relativePointSchema},required:['leaseId']},'tap');
  register(server,'android_swipe','写操作：按“手指运动方向”滑动，支持距离比例和持续时间。',{properties:{leaseId:{type:'string'},direction:{type:'string',enum:['up','down','left','right']},distanceRatio:{type:'number',minimum:.1,maximum:.85},durationMs:{type:'integer',minimum:150,maximum:1500}},required:['leaseId','direction']},'swipe');
  register(server,'android_drag','写操作：精确拖动。起止点可使用 0–1 相对坐标或结构化 Selector，并保留防惯性结束。',{properties:{leaseId:{type:'string'},from:relativePointSchema,to:relativePointSchema,fromSelector:selectorSchema,toSelector:selectorSchema,durationMs:{type:'integer',minimum:180,maximum:3000}},required:['leaseId']},'drag');
  register(server,'android_input_text','写操作：可先用 Selector 聚焦输入框再输入。输入值不会进入日志、诊断或工具摘要。',{properties:{leaseId:{type:'string'},selector:selectorSchema,text:{type:'string',minLength:1,maxLength:2000}},required:['leaseId','text']},'input_text');
  register(server,'android_press_key','写操作：仅允许 back、home、recent、enter 白名单按键。',{properties:{leaseId:{type:'string'},key:{type:'string',enum:['back','home','recent','enter']}},required:['leaseId','key']},'press_key');
  register(server,'android_status_bar','写操作：显式打开通知栏、快捷设置或收起系统面板；不依赖二次点击或下拉手势。',{properties:{leaseId:{type:'string'},action:{type:'string',enum:['notifications','quick_settings','collapse']}},required:['leaseId','action']},'status_bar');
  register(server,'android_launch_app','写操作：启动已安装应用，可选 Activity 或 deep link；默认不清除 App 数据。',{properties:{leaseId:{type:'string'},packageName:{type:'string'},activity:{type:'string'},deepLink:{type:'string'}},required:['leaseId','packageName']},'launch_app');
  register(server,'android_wait_for','只读等待：支持元素出现/消失、文字、包名/Activity、screenId 和 UI 稳定；有明确超时，不会无限轮询。',{properties:{selector:selectorSchema,state:{type:'string',enum:['visible','present','gone','hidden']},text:{type:'string'},packageName:{type:'string'},activity:{type:'string'},screenId:{type:'string'},uiStable:{type:'boolean'},stableMs:{type:'integer'},timeoutMs:{type:'integer',minimum:250,maximum:120000}}},'wait_for');
  register(server,'android_checkpoint','只读证据保存：保存手机原始 PNG、页面 XML、Snapshot、RuntimeSpec（若有）、manifest 和 SHA-256。',{properties:{name:{type:'string',maxLength:80}}},'checkpoint');
  register(server,'android_disconnect','高影响写操作：断开当前手机会话，必须持有有效 AI 控制租约。',{properties:{leaseId:{type:'string'}},required:['leaseId']},'disconnect');
  return server;
}

if(process.env.ANDROID_LINK_MCP_SELF_TEST==='1'){
  try{
    const server=createServer();
    const status=await ipcCall('status',{}, {timeoutMs:5000});
    const tools=Array.isArray(server.__androidLinkToolNames)?server.__androidLinkToolNames:[];
    process.stdout.write(JSON.stringify({ok:true,version:VERSION,transport:'stdio',toolCount:tools.length,tools,status:{connected:Boolean(status?.connected),device:status?.device?{model:status.device.model||null,os:status.device.os||null}:null}})+'\n');
    process.exit(0);
  }catch(error){console.error('MCP self-test failed:',String(error?.message||error).slice(0,400));process.exit(2);}
}

console.error(`android-link MCP ${VERSION} running on stdio`);
let stdioHandle;
try{stdioHandle=serveStdio(() => createServer());}
catch(error){console.error('MCP stdio server stopped:', String(error?.message || error).slice(0,300));process.exitCode=2;}
let closing=false;
const closeStdio=async()=>{if(closing)return;closing=true;try{await stdioHandle?.close?.();}catch(error){console.error('MCP stdio close failed:',String(error?.message||error).slice(0,300));}};
for(const signal of ['SIGINT','SIGTERM','SIGHUP']) process.once(signal,()=>{void closeStdio().finally(()=>process.exit(0));});
