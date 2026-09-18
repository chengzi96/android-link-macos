import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {ScrcpyPacketParser, ScrcpyVideoStream, ScrcpyControlStream, normalizeStreamFps, streamProfile, streamProfileLadder, parseRefreshRate, parseDisplayModeRates, chooseDeviceRefreshRate, parseH264Encoders, adaptiveStreamAttempts, eventToEnvelope, STREAM_EVENT}
  from '../src/video-stream.mjs';
import {StreamEnvelopeParser, JpegStreamParser, h264CodecString, chooseTargetFps}
  from '../src/stream-client.mjs';
import {MjpegVideoStream, normalizeMjpegFps, mjpegProfile, adaptiveMjpegProfile} from '../src/mjpeg-stream.mjs';

function session(width,height){const b=Buffer.alloc(12);b[0]=0x80;b.writeUInt32BE(width,4);b.writeUInt32BE(height,8);return b;}
function packet(payload,{config=false,key=false,pts=1234n}={}){const h=Buffer.alloc(12);let v=pts;if(config)v|=1n<<62n;if(key)v|=1n<<61n;h.writeBigUInt64BE(v,0);h.writeUInt32BE(payload.length,8);return Buffer.concat([h,payload]);}

test('stream fps profiles adapt to browser and device refresh rate',()=>{
 assert.equal(normalizeStreamFps(30),30);assert.equal(normalizeStreamFps(80),90);assert.equal(normalizeStreamFps(144),120);
 assert.deepEqual(streamProfile(120),{fps:120,maxSize:1280,bitRate:7_000_000});
 assert.equal(chooseTargetFps(120,60),60);assert.equal(chooseTargetFps(120,90),90);assert.equal(chooseTargetFps(120,120),120);
 assert.deepEqual(streamProfileLadder(120,60).map(x=>x.fps),[60,45,30]);
 assert.deepEqual(streamProfileLadder(120,120).map(x=>x.fps),[120,90,60,45,30]);
});

test('device refresh parser recognizes common Android dumpsys and settings output',()=>{
 assert.equal(parseRefreshRate('120.0'),120);
 assert.equal(parseRefreshRate('peak_refresh_rate=120.0\nmin_refresh_rate=60.0'),120);
 assert.equal(parseRefreshRate('mRefreshRate=60.000004 fps=60'),60.000004);
 assert.equal(parseRefreshRate('unknown'),null);
});


test('scrcpy direct touch uses the official 32-byte touch message and exact frame coordinates',()=>{
 const stream=new ScrcpyVideoStream({}, {controlEnabled:true});
 const down=stream.touchMessage('down',{x:100,y:200},{width:1080,height:1920});
 assert.equal(down.length,32);assert.equal(down[0],2);assert.equal(down[1],0);
 assert.equal(down.readBigUInt64BE(2),0xfffffffffffffffen);
 assert.equal(down.readInt32BE(10),100);assert.equal(down.readInt32BE(14),200);
 assert.equal(down.readUInt16BE(18),1080);assert.equal(down.readUInt16BE(20),1920);assert.equal(down.readUInt16BE(22),0xffff);
 const move=stream.touchMessage('move',{x:540,y:960},{width:1080,height:1920});assert.equal(move[1],2);assert.equal(move.readInt32BE(10),540);assert.equal(move.readInt32BE(14),960);
 const up=stream.touchMessage('up',{x:540,y:960},{width:1080,height:1920});assert.equal(up[1],1);assert.equal(up.readUInt16BE(22),0);
});

test('scrcpy v4.1 packet parser preserves rotation, config, key and delta boundaries',()=>{
 const events=[],parser=new ScrcpyPacketParser(e=>events.push(e));
 const config=Buffer.from('000000016764001f0000000168ee3c80','hex'),key=Buffer.from('00000001658884','hex'),delta=Buffer.from('00000001419a22','hex');
 const stream=Buffer.concat([Buffer.from('h264'),session(720,1600),packet(config,{config:true,pts:0n}),packet(key,{key:true,pts:10n}),packet(delta,{pts:20n}),session(1600,720)]);
 for(let i=0;i<stream.length;i+=7)parser.feed(stream.subarray(i,i+7));
 assert.deepEqual(events.map(e=>e.type),['resize','config','key','delta','resize']);
 assert.deepEqual([events[0].width,events[0].height],[720,1600]);assert.equal(events[2].timestamp,10n);assert.equal(events[4].width,1600);
});

test('scrcpy parser exposes explicit encoder rejection instead of generic fallback',()=>{
 const parser=new ScrcpyPacketParser(()=>{});
 assert.throws(()=>parser.feed(Buffer.from([0,0,0,1])),/编码器拒绝/);
});

test('browser envelope parser and H264 codec detection match server framing',()=>{
 const config=Buffer.from('000000016764001f0000000168ee3c80','hex');
 assert.equal(h264CodecString(config),'avc1.64001F');
 const events=[];const parser=new StreamEnvelopeParser(e=>events.push(e));
 const bytes=Buffer.concat([Buffer.from('ALV1'),eventToEnvelope({type:'resize',width:720,height:1600}),eventToEnvelope({type:'config',payload:config,timestamp:0n}),eventToEnvelope({type:'key',payload:Buffer.from([1,2,3]),timestamp:99n})]);
 for(let i=0;i<bytes.length;i+=5)parser.feed(bytes.subarray(i,i+5));
 assert.deepEqual(events.map(e=>e.type),['resize','config','key']);assert.equal(events[0].height,1600);assert.equal(events[2].timestamp,99n);
});

test('MJPEG fallback extracts the newest JPEG frames and caps at 60 fps',()=>{
 const frames=[],parser=new JpegStreamParser(frame=>frames.push(Buffer.from(frame)));
 const jpeg1=Buffer.from([0xff,0xd8,1,2,3,0xff,0xd9]),jpeg2=Buffer.from([0xff,0xd8,9,8,7,0xff,0xd9]);
 const multipart=Buffer.concat([Buffer.from('--b\r\nContent-Type:image/jpeg\r\n\r\n'),jpeg1,Buffer.from('\r\n--b\r\n'),jpeg2]);
 for(let i=0;i<multipart.length;i+=4)parser.feed(multipart.subarray(i,i+4));
 assert.equal(frames.length,2);assert.deepEqual(frames[0],jpeg1);assert.deepEqual(frames[1],jpeg2);
 assert.equal(normalizeMjpegFps(120),60);assert.deepEqual(mjpegProfile(60),{fps:60,scaling:45,quality:45});
});

test('stream envelope rejects oversized payload declarations',()=>{
 const parser=new StreamEnvelopeParser(()=>{});const bad=Buffer.alloc(17);Buffer.from('ALV1').copy(bad,0);bad[4]=STREAM_EVENT.KEY;bad.writeUInt32BE(33*1024*1024,13);
 assert.throws(()=>parser.feed(bad),/数据异常/);
});


test('scrcpy stream waits for valid codec, size and config before reporting ready', async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'androidlink-scrcpy-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const fakeAdb=path.join(dir,'adb');fs.writeFileSync(fakeAdb,'#!/bin/sh\nexec /bin/sleep 30\n');fs.chmodSync(fakeAdb,0o700);
 const serverPath=path.join(dir,'scrcpy-server');fs.writeFileSync(serverPath,'fake');
 let tcpServer=null,forwardPort=null;
 const helper={device:{serial:'test-device'},session:'session-1',scrcpyServerPath:serverPath,adbPath:fakeAdb,env:process.env,children:new Set(),
  async adb(args){const spec=args.find(x=>String(x).startsWith('tcp:'));if(args.includes('forward')&&!args.includes('--remove')&&spec){forwardPort=Number(spec.slice(4));tcpServer=net.createServer(socket=>{socket.on('error',()=>{});const config=Buffer.from('000000016764001f0000000168ee3c80','hex');socket.write(Buffer.concat([Buffer.from('h264'),session(720,1600),packet(config,{config:true,pts:0n})]));});await new Promise((resolve,reject)=>{tcpServer.once('error',reject);tcpServer.listen(forwardPort,'127.0.0.1',resolve);});}if(args.includes('--remove')&&tcpServer){await new Promise(resolve=>tcpServer.close(()=>resolve()));tcpServer=null;}return '';},
  terminateChild(child){try{child.kill('SIGTERM');}catch{}}
 };
 const events=[],stream=new ScrcpyVideoStream(helper,{onEvent:e=>events.push(e)});t.after(()=>stream.stop());
 const profile=await stream.startProfile({fps:60,maxSize:1280,bitRate:4_000_000},1500);
 assert.equal(profile.fps,60);assert.deepEqual(events.map(e=>e.type),['resize','config']);assert.equal(forwardPort>0,true);
 await stream.stop();
});

test('UiAutomator2 MJPEG fallback configures lightweight stream and uses dynamic localhost forwarding', async t=>{
 let settings=null,tcpServer=null,forwardPort=null;const jpeg=Buffer.from([0xff,0xd8,1,2,3,0xff,0xd9]);
 const helper={device:{serial:'test-device'},session:'session-1',
  async adb(args){const spec=args.find(x=>String(x).startsWith('tcp:'));if(args.includes('forward')&&!args.includes('--remove')&&spec){forwardPort=Number(spec.slice(4));tcpServer=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'multipart/x-mixed-replace; boundary=--BoundaryString'});res.write(Buffer.concat([Buffer.from('--BoundaryString\r\nContent-Type: image/jpeg\r\nContent-Length: '+jpeg.length+'\r\n\r\n'),jpeg,Buffer.from('\r\n')]));});await new Promise((resolve,reject)=>{tcpServer.once('error',reject);tcpServer.listen(forwardPort,'127.0.0.1',resolve);});}if(args.includes('--remove')&&tcpServer){await new Promise(resolve=>tcpServer.close(()=>resolve()));tcpServer=null;}return '';}
 };
 const stream=new MjpegVideoStream(helper,{updateSettings:async value=>{settings=value;}});t.after(()=>stream.stop());
 const result=await stream.start(60,1500);assert.equal(result.profile.fps,60);assert.equal(settings.mjpegServerFramerate,60);assert.equal(settings.mjpegScalingFactor,45);assert.equal(forwardPort>0,true);
 await stream.stop();
});

test('scrcpy control-channel loss falls back to Appium touch without killing H264 video', async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'androidlink-scrcpy-control-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const fakeAdb=path.join(dir,'adb');fs.writeFileSync(fakeAdb,'#!/bin/sh\nexec /bin/sleep 30\n');fs.chmodSync(fakeAdb,0o700);
 const serverPath=path.join(dir,'scrcpy-server');fs.writeFileSync(serverPath,'fake');
 let tcpServer=null,forwardPort=null,connections=0;
 const helper={device:{serial:'test-device'},session:'session-1',scrcpyServerPath:serverPath,adbPath:fakeAdb,env:process.env,children:new Set(),
  async adb(args){const spec=args.find(x=>String(x).startsWith('tcp:'));if(args.includes('forward')&&!args.includes('--remove')&&spec){forwardPort=Number(spec.slice(4));tcpServer=net.createServer(socket=>{socket.on('error',()=>{});connections+=1;if(connections===1){const config=Buffer.from('000000016764001f0000000168ee3c80','hex');socket.write(Buffer.concat([Buffer.from('h264'),session(720,1600),packet(config,{config:true,pts:0n})]));}else{setTimeout(()=>socket.end(),420);}});await new Promise((resolve,reject)=>{tcpServer.once('error',reject);tcpServer.listen(forwardPort,'127.0.0.1',resolve);});}if(args.includes('--remove')&&tcpServer){await new Promise(resolve=>tcpServer.close(()=>resolve()));tcpServer=null;}return '';},
  terminateChild(child){try{child.kill('SIGTERM');}catch{}}
 };
 let videoErrors=0,controlErrors=0;
 const stream=new ScrcpyVideoStream(helper,{controlEnabled:true,onError:()=>videoErrors+=1,onControlError:()=>controlErrors+=1});t.after(()=>stream.stop());
 await stream.startProfile({fps:60,maxSize:1280,bitRate:4_000_000},1500);
 assert.equal(stream.canControl(),true);
 await new Promise(resolve=>setTimeout(resolve,260));
 assert.equal(controlErrors,1);assert.equal(videoErrors,0);assert.equal(stream.canControl(),false);
 assert.equal(Boolean(stream.socket&&!stream.socket.destroyed),true,'video socket must remain alive');
 await stream.stop();
});


test('device refresh parser ignores touch-sampling values when an active display mode is available',()=>{
 const dump='mActiveModeId=0, activeMode={id=0, width=1080, height=2400, fps=60.000004}\nsupportedModes=[DisplayMode{id=0,fps=60.0}]\nrender stats fps=240\ntouchSamplingRate=240Hz';
 assert.equal(Math.round(parseRefreshRate(dump)),60);
 assert.deepEqual(parseDisplayModeRates(dump).map(x=>Math.round(x)),[60]);
 assert.equal(chooseDeviceRefreshRate(240,null,60,[60]),60,'touch-sampling-like 240Hz must not override a 60Hz panel');
 assert.equal(chooseDeviceRefreshRate(null,120,60,[60,120]),120,'a supported 120Hz mode may be selected even when currently active at 60Hz');
});

test('H264 encoder discovery prefers remembered and hardware vendor encoders before software fallbacks',()=>{
 const raw=`[server] INFO: List of video encoders:\n--video-codec=h264 --video-encoder=c2.android.avc.encoder(sw)\n--video-codec=h264 --video-encoder=c2.qti.avc.encoder(hw) [vendor]\n--video-codec=h264 --video-encoder=OMX.qcom.video.encoder.avc(hw) [vendor]`;
 const encoders=parseH264Encoders(raw);assert.equal(encoders.length,3);assert.equal(encoders.find(x=>x.name==='c2.qti.avc.encoder').hardware,true);
 const attempts=adaptiveStreamAttempts(120,60,encoders,{encoder:'c2.qti.avc.encoder',fps:60});
 assert.equal(attempts[0].fps,60);assert.equal(attempts[0].encoder,'c2.qti.avc.encoder');
 assert.equal(attempts.some(x=>x.encoder===null),true);assert.equal(attempts.every(x=>x.fps<=60),true);
 assert.equal(attempts.some(x=>x.encoder==='c2.android.avc.encoder'),false,'software encoder should not be preferred for low-latency mirroring');assert.equal(attempts.length<=8,true,'fallback matrix must stay bounded so MJPEG is reached quickly');
});

test('adaptive MJPEG trades excess target fps for clarity when the device has already proven slow',()=>{
 assert.deepEqual(adaptiveMjpegProfile(60,13),{fps:20,scaling:65,quality:58});
 assert.deepEqual(adaptiveMjpegProfile(60,22),{fps:30,scaling:60,quality:55});
 assert.deepEqual(adaptiveMjpegProfile(60,58),mjpegProfile(60));
});


test('scrcpy control-only channel provides realtime touch even when video is handled by MJPEG', async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'androidlink-control-only-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const fakeAdb=path.join(dir,'adb');fs.writeFileSync(fakeAdb,'#!/bin/sh\nexec /bin/sleep 30\n');fs.chmodSync(fakeAdb,0o700);
 const serverPath=path.join(dir,'scrcpy-server');fs.writeFileSync(serverPath,'fake');
 let tcpServer=null,forwardPort=null,received=Buffer.alloc(0);
 const helper={device:{serial:'test-device'},session:'session-1',scrcpyServerPath:serverPath,adbPath:fakeAdb,env:process.env,children:new Set(),
  async adb(args){const spec=args.find(x=>String(x).startsWith('tcp:'));if(args.includes('forward')&&!args.includes('--remove')&&spec){forwardPort=Number(spec.slice(4));tcpServer=net.createServer(socket=>{socket.on('data',chunk=>{received=Buffer.concat([received,chunk]);});socket.on('error',()=>{});});await new Promise((resolve,reject)=>{tcpServer.once('error',reject);tcpServer.listen(forwardPort,'127.0.0.1',resolve);});}if(args.includes('--remove')&&tcpServer){await new Promise(resolve=>tcpServer.close(()=>resolve()));tcpServer=null;}return '';},
  terminateChild(child){try{child.kill('SIGTERM');}catch{}}
 };
 const stream=new ScrcpyControlStream(helper);t.after(()=>stream.stop());await stream.start(1500);assert.equal(stream.canControl(),true);
 await stream.injectTouch('down',{x:100,y:200},{width:1080,height:1920});await new Promise(resolve=>setTimeout(resolve,30));
 assert.equal(received.length>=32,true);assert.equal(received[0],2);assert.equal(received[1],0);assert.equal(received.readInt32BE(10),100);assert.equal(received.readInt32BE(14),200);
 await stream.stop();
});
