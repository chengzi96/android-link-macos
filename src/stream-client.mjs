export const STREAM_EVENT={CONFIG:1,KEY:2,DELTA:3,RESIZE:4};

export function chooseTargetFps(displayHz,deviceHz=null){
 const browser=Number(displayHz),device=Number(deviceHz);let cap=Number.isFinite(browser)?browser:60;if(Number.isFinite(device)&&device>=24)cap=Math.min(cap,device);
 if(cap>=105)return 120;if(cap>=75)return 90;if(cap>=50)return 60;if(cap>=38)return 45;return 30;
}

export async function measureDisplayHz(samples=24){
 if(typeof requestAnimationFrame!=='function')return 60;
 const times=[];await new Promise(resolve=>{const tick=t=>{times.push(t);if(times.length>=samples+1)return resolve();requestAnimationFrame(tick);};requestAnimationFrame(tick);});
 const deltas=[];for(let i=1;i<times.length;i++){const d=times[i]-times[i-1];if(d>2&&d<50)deltas.push(d);}if(!deltas.length)return 60;
 deltas.sort((a,b)=>a-b);const median=deltas[Math.floor(deltas.length/2)];return Math.max(30,Math.min(240,1000/median));
}

function concatBytes(a,b){const out=new Uint8Array(a.length+b.length);out.set(a,0);out.set(b,a.length);return out;}

export function h264CodecString(config){
 const data=config instanceof Uint8Array?config:new Uint8Array(config);let i=0;
 while(i+4<data.length){let start=-1;if(data[i]===0&&data[i+1]===0&&data[i+2]===1)start=i+3;else if(i+4<data.length&&data[i]===0&&data[i+1]===0&&data[i+2]===0&&data[i+3]===1)start=i+4;
  if(start>=0){const type=data[start]&31;if(type===7&&start+3<data.length)return 'avc1.'+[data[start+1],data[start+2],data[start+3]].map(v=>v.toString(16).padStart(2,'0')).join('').toUpperCase();i=start+1;continue;}i++;}
 throw new Error('H.264 配置中没有 SPS。');
}

export class StreamEnvelopeParser{
 constructor(onEvent){this.onEvent=onEvent;this.buffer=new Uint8Array(0);this.magic=false;}
 feed(chunk){const input=chunk instanceof Uint8Array?chunk:new Uint8Array(chunk);this.buffer=this.buffer.length?concatBytes(this.buffer,input):new Uint8Array(input);
  for(;;){if(!this.magic){if(this.buffer.length<4)return;const magic=String.fromCharCode(...this.buffer.subarray(0,4));if(magic!=='ALV1')throw new Error('实时流协议不匹配。');this.buffer=this.buffer.slice(4);this.magic=true;continue;}
   if(this.buffer.length<13)return;const view=new DataView(this.buffer.buffer,this.buffer.byteOffset,this.buffer.byteLength);const type=view.getUint8(0),timestamp=view.getBigUint64(1),length=view.getUint32(9);if(length>32*1024*1024)throw new Error('实时流数据异常。');if(this.buffer.length<13+length)return;const payload=this.buffer.slice(13,13+length);this.buffer=this.buffer.slice(13+length);
   if(type===STREAM_EVENT.RESIZE){if(payload.length!==8)throw new Error('实时流尺寸包异常。');const pv=new DataView(payload.buffer,payload.byteOffset,payload.byteLength);this.onEvent({type:'resize',width:pv.getUint32(0),height:pv.getUint32(4)});}else if(type===STREAM_EVENT.CONFIG)this.onEvent({type:'config',timestamp,payload});else if(type===STREAM_EVENT.KEY)this.onEvent({type:'key',timestamp,payload});else if(type===STREAM_EVENT.DELTA)this.onEvent({type:'delta',timestamp,payload});else throw new Error('未知实时流事件。');}}
}

export class JpegStreamParser{
 constructor(onFrame){this.onFrame=onFrame;this.buffer=new Uint8Array(0);}
 feed(chunk){const input=chunk instanceof Uint8Array?chunk:new Uint8Array(chunk);this.buffer=this.buffer.length?concatBytes(this.buffer,input):new Uint8Array(input);
  for(;;){let start=-1;for(let i=0;i+1<this.buffer.length;i++){if(this.buffer[i]===0xff&&this.buffer[i+1]===0xd8){start=i;break;}}if(start<0){if(this.buffer.length>2)this.buffer=this.buffer.slice(-2);return;}if(start>0)this.buffer=this.buffer.slice(start);
   let end=-1;for(let i=2;i+1<this.buffer.length;i++){if(this.buffer[i]===0xff&&this.buffer[i+1]===0xd9){end=i+2;break;}}if(end<0){if(this.buffer.length>16*1024*1024)throw new Error('MJPEG 单帧异常过大。');return;}const frame=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end);this.onFrame(frame);}}
}

export async function playRealtimeStream({token,canvas,targetFps=60,signal,probe=false,onState=()=>{},onStats=()=>{}}){
 if(typeof VideoDecoder==='undefined'||typeof EncodedVideoChunk==='undefined')throw new Error('当前浏览器不支持 WebCodecs H.264 解码。');
 const response=await fetch('/api/stream?fps='+encodeURIComponent(targetFps)+(probe?'&probe=1':''),{headers:{'X-AndroidLink-Token':token},signal});
 if(!response.ok){const data=await response.json().catch(()=>({}));const e=new Error(data.error||'H.264 实时流启动失败。');e.details=data;throw e;}
 if(!response.body)throw new Error('浏览器无法读取 H.264 实时流。');
 const actualTarget=Number(response.headers.get('X-AndroidLink-Target-Fps'))||targetFps,directTouch=response.headers.get('X-AndroidLink-Touch')==='scrcpy',streamId=response.headers.get('X-AndroidLink-Stream-Id')||'',isProbe=response.headers.get('X-AndroidLink-Probe')==='1',encoder=response.headers.get('X-AndroidLink-Encoder')||'default';
 const ctx=canvas.getContext('2d',{alpha:false,desynchronized:true});if(!ctx)throw new Error('浏览器无法创建视频画布。');
 let decoder=null,config=null,pendingFrame=null,raf=0,frames=0,lastFrames=0,lastTick=performance.now(),firstFrame=false,configuredCodec='',dropUntilKey=false,fatalReject;
 const fatal=new Promise((_,reject)=>{fatalReject=reject;});
 const firstFrameTimer=setTimeout(()=>{if(!firstFrame)fatalReject(new Error('H.264 已建立，但浏览器在 4 秒内没有解码出首帧。'));},4000);
 const render=()=>{raf=0;if(!pendingFrame)return;const frame=pendingFrame;pendingFrame=null;try{const w=frame.displayWidth||frame.codedWidth,h=frame.displayHeight||frame.codedHeight;if(w&&h&&(canvas.width!==w||canvas.height!==h)){canvas.width=w;canvas.height=h;}ctx.drawImage(frame,0,0,canvas.width,canvas.height);frames++;if(!firstFrame){firstFrame=true;onState({state:'playing',codec:configuredCodec,encoder,targetFps:actualTarget,mode:'h264',directTouch,streamId,probe:isProbe});}}finally{frame.close();}if(pendingFrame&&!raf)raf=requestAnimationFrame(render);};
 const closeDecoder=()=>{if(pendingFrame){pendingFrame.close();pendingFrame=null;}if(raf){cancelAnimationFrame(raf);raf=0;}if(decoder){try{decoder.close();}catch{}decoder=null;}};
 const configure=bytes=>{const codec=h264CodecString(bytes);configuredCodec=codec;closeDecoder();decoder=new VideoDecoder({output:frame=>{if(pendingFrame)pendingFrame.close();pendingFrame=frame;if(!raf)raf=requestAnimationFrame(render);},error:error=>{const message=String(error?.message||error);onState({state:'decoder-error',error:message});fatalReject(new Error('浏览器 H.264 解码失败：'+message));}});
  try{decoder.configure({codec,optimizeForLatency:true,hardwareAcceleration:'prefer-hardware'});}catch{decoder.configure({codec,optimizeForLatency:true});}onState({state:'configured',codec,encoder,targetFps:actualTarget,mode:'h264',directTouch,streamId,probe:isProbe});};
 const parser=new StreamEnvelopeParser(event=>{if(event.type==='resize'){onState({state:'resize',width:event.width,height:event.height,mode:'h264'});return;}if(event.type==='config'){config=event.payload;configure(config);return;}if(!decoder||!config||decoder.state!=='configured')return;if(event.type==='delta'&&(dropUntilKey||decoder.decodeQueueSize>3)){dropUntilKey=true;return;}let data=event.payload;if(event.type==='key'){dropUntilKey=false;data=concatBytes(config,event.payload);}try{decoder.decode(new EncodedVideoChunk({type:event.type==='key'?'key':'delta',timestamp:Number(event.timestamp),data}));}catch{}});
 const statsTimer=setInterval(()=>{const now=performance.now(),seconds=(now-lastTick)/1000,delta=frames-lastFrames;onStats({fps:seconds>0?delta/seconds:0,targetFps:actualTarget,decodeQueue:decoder?.decodeQueueSize||0,mode:'h264'});lastFrames=frames;lastTick=now;},1000);
 const reader=response.body.getReader();onState({state:'connected',encoder,targetFps:actualTarget,mode:'h264',directTouch,streamId,probe:isProbe});
 try{for(;;){const {value,done}=await Promise.race([reader.read(),fatal]);if(done)break;if(value)parser.feed(value);}if(!signal?.aborted)throw new Error('H.264 实时视频流已结束。');}
 finally{clearTimeout(firstFrameTimer);clearInterval(statsTimer);try{reader.cancel();}catch{}closeDecoder();}
}

export async function playMjpegStream({token,canvas,targetFps=30,signal,onState=()=>{},onStats=()=>{}}){
 const response=await fetch('/api/mjpeg?fps='+encodeURIComponent(targetFps),{headers:{'X-AndroidLink-Token':token},signal});
 if(!response.ok){const data=await response.json().catch(()=>({}));const e=new Error(data.error||'MJPEG 实时流启动失败。');e.details=data;throw e;}if(!response.body)throw new Error('浏览器无法读取 MJPEG 实时流。');
 const actualTarget=Number(response.headers.get('X-AndroidLink-Target-Fps'))||targetFps,directTouch=response.headers.get('X-AndroidLink-Touch')==='scrcpy',ctx=canvas.getContext('2d',{alpha:false,desynchronized:true});if(!ctx)throw new Error('浏览器无法创建 MJPEG 画布。');
 let latest=null,rendering=false,frames=0,lastFrames=0,lastTick=performance.now(),first=false,closed=false,fatalReject;
 const fatal=new Promise((_,reject)=>{fatalReject=reject;});
 const firstFrameTimer=setTimeout(()=>{if(!first)fatalReject(new Error('MJPEG 已建立，但 4 秒内没有收到可显示画面。'));},4000);
 const render=async()=>{if(rendering||!latest||closed)return;rendering=true;const bytes=latest;latest=null;try{const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/jpeg'}));if(closed){bitmap.close();return;}if(canvas.width!==bitmap.width||canvas.height!==bitmap.height){canvas.width=bitmap.width;canvas.height=bitmap.height;onState({state:'resize',width:bitmap.width,height:bitmap.height,mode:'mjpeg',directTouch});}ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();frames++;if(!first){first=true;onState({state:'playing',targetFps:actualTarget,mode:'mjpeg',directTouch});}}finally{rendering=false;if(latest&&!closed)queueMicrotask(()=>render().catch(error=>fatalReject(new Error('MJPEG 解码失败：'+String(error?.message||error)))));}};
 const parser=new JpegStreamParser(frame=>{latest=frame;if(!rendering)queueMicrotask(()=>render().catch(error=>fatalReject(new Error('MJPEG 解码失败：'+String(error?.message||error)))));});
 const statsTimer=setInterval(()=>{const now=performance.now(),seconds=(now-lastTick)/1000,delta=frames-lastFrames;onStats({fps:seconds>0?delta/seconds:0,targetFps:actualTarget,decodeQueue:latest?1:0,mode:'mjpeg'});lastFrames=frames;lastTick=now;},1000);
 const reader=response.body.getReader();onState({state:'connected',targetFps:actualTarget,mode:'mjpeg',directTouch});
 try{for(;;){const {value,done}=await Promise.race([reader.read(),fatal]);if(done)break;if(value)parser.feed(value);}if(!signal?.aborted)throw new Error('MJPEG 实时视频流已结束。');}
 finally{closed=true;latest=null;clearTimeout(firstFrameTimer);clearInterval(statsTimer);try{reader.cancel();}catch{}}
}
