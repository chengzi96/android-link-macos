#!/usr/bin/env node
import {ipcCall} from './ipc-client.mjs';
import {AutomationError} from './automation-errors.mjs';

const EXIT = Object.freeze({ASSISTANT_NOT_RUNNING:3,PROTOCOL_VERSION_UNSUPPORTED:3,AUTH_FAILED:3,DEVICE_NOT_CONNECTED:4,DEVICE_LOCKED:4,SESSION_NOT_READY:4,LEASE_REQUIRED:5,LEASE_CONFLICT:5,LEASE_EXPIRED:5,
  INVALID_SELECTOR:6,ELEMENT_NOT_FOUND:6,AMBIGUOUS_ELEMENT:6,STALE_ELEMENT:6,ACTION_TIMEOUT:7,WAIT_TIMEOUT:7,APP_NOT_INSTALLED:8,RUNTIME_SPEC_UNAVAILABLE:8,HUMAN_ACTION_REQUIRED:8,RATE_LIMITED:9,INTERNAL_ERROR:10});

function help(){return `安卓连接助手 AI CLI\n\n用法：\n  android-link status --json\n  android-link observe --screenshot --tree summary --runtime-spec --json\n  android-link find --resource-id com.example:id/buy --json\n  android-link acquire-control --owner codex --ttl 60000 --json\n  android-link tap --resource-id com.example:id/buy --lease-id <LEASE_ID> --json\n  android-link swipe --direction up --distance 0.5 --lease-id <LEASE_ID> --json\n  android-link status-bar --action notifications --lease-id <LEASE_ID> --json\n  android-link input --resource-id com.example:id/search --text "dress" --lease-id <LEASE_ID> --json\n  android-link wait --resource-id com.example:id/buy --state visible --timeout 15000 --json\n  android-link checkpoint --name 示例页面 --json\n  android-link release-control --lease-id <LEASE_ID> --json\n\n说明：\n  - 控制类命令必须传 --lease-id，或设置本次进程环境变量 ANDROID_LINK_LEASE_ID。\n  - stdout 只输出结果 JSON；输入文字不会进入日志或错误摘要。\n  - CLI 完整路径由安装器写入 ~/Library/Application Support/AndroidLink/bin/android-link。`}
function parse(argv){
  const out={_:[]};for(let i=0;i<argv.length;i++){const arg=argv[i];if(!arg.startsWith('--')){out._.push(arg);continue;}const key=arg.slice(2);if(['json','screenshot','runtime-spec','ui-stable','help'].includes(key)){out[key]=true;continue;}if(i+1>=argv.length||argv[i+1].startsWith('--'))throw new Error(`参数 --${key} 缺少值。`);out[key]=argv[++i];}return out;
}
function number(value,name){const n=Number(value);if(!Number.isFinite(n))throw new Error(`${name} 必须是数字。`);return n;}
function selector(a){const s={};if(a['qa-id'])s.qaId=a['qa-id'];if(a['resource-id'])s.resourceId=a['resource-id'];if(a.text)s.text={equals:a.text};if(a['content-desc'])s.contentDescription={equals:a['content-desc']};if(a.class)s.className=a.class;if(a.index!=null)s.index=number(a.index,'index');if(a['element-ref'])s.elementRef=a['element-ref'];return Object.keys(s).length?s:null;}
function lease(a){return a['lease-id']||process.env.ANDROID_LINK_LEASE_ID||null;}
function output(value){process.stdout.write(JSON.stringify(value)+'\n');}
function errorOutput(error){const code=error instanceof AutomationError?error.code:'INTERNAL_ERROR';const value={ok:false,error:{code,message:String(error?.message||error).slice(0,400),retryable:Boolean(error?.retryable),details:error?.details||{}}};output(value);process.exitCode=EXIT[code]||10;}

async function main(){
  const args=parse(process.argv.slice(2)),command=args._[0];if(!command||command==='help'||args.help){process.stdout.write(help()+'\n');return;}
  let method,params={},timeoutMs;
  switch(command){
    case 'status':method='status';break;
    case 'observe':method='observe';params={screenshot:Boolean(args.screenshot),tree:args.tree||'summary',runtimeSpec:Boolean(args['runtime-spec'])};break;
    case 'find':method='find_elements';params={selector:selector(args)};if(!params.selector)throw new Error('find 需要 Selector。');break;
    case 'acquire-control':method='acquire_control';params={owner:args.owner||'cli',ttlMs:args.ttl?number(args.ttl,'ttl'):undefined};break;
    case 'renew-control':method='renew_control';params={leaseId:lease(args),ttlMs:args.ttl?number(args.ttl,'ttl'):undefined};break;
    case 'release-control':method='release_control';params={leaseId:lease(args)};break;
    case 'tap':method='tap';params={leaseId:lease(args),selector:selector(args)};if(!params.selector){params.point={x:number(args.x,'x'),y:number(args.y,'y')};delete params.selector;}break;
    case 'swipe':method='swipe';params={leaseId:lease(args),direction:args.direction,distanceRatio:args.distance?number(args.distance,'distance'):undefined,durationMs:args.duration?number(args.duration,'duration'):undefined};break;
    case 'drag':method='drag';params={leaseId:lease(args),durationMs:args.duration?number(args.duration,'duration'):undefined,from:{x:number(args['from-x'],'from-x'),y:number(args['from-y'],'from-y')},to:{x:number(args['to-x'],'to-x'),y:number(args['to-y'],'to-y')}};break;
    case 'input':method='input_text';params={leaseId:lease(args),selector:selector(args),text:args.text};if(!params.selector)delete params.selector;break;
    case 'press-key':method='press_key';params={leaseId:lease(args),key:args.key};break;
    case 'status-bar':method='status_bar';params={leaseId:lease(args),action:args.action};break;
    case 'launch-app':method='launch_app';params={leaseId:lease(args),packageName:args.package,activity:args.activity,deepLink:args['deep-link']};break;
    case 'wait':method='wait_for';params={selector:selector(args),state:args.state,timeoutMs:args.timeout?number(args.timeout,'timeout'):undefined,packageName:args.package,activity:args.activity,screenId:args['screen-id'],uiStable:Boolean(args['ui-stable']),text:args['contains-text']};Object.keys(params).forEach(k=>params[k]==null&&delete params[k]);timeoutMs=(params.timeoutMs||15000)+5000;break;
    case 'checkpoint':method='checkpoint';params={name:args.name||'检查点'};timeoutMs=60000;break;
    case 'runtime-spec':method='get_runtime_spec';break;
    case 'disconnect':method='disconnect';params={leaseId:lease(args)};break;
    default:throw new Error(`未知命令：${command}`);
  }
  const result=await ipcCall(method,params,{timeoutMs});output({ok:true,result});
}
main().catch(errorOutput);
