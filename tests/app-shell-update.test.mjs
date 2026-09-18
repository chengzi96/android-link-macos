import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {applyPatchDirectory, rollbackCode, validatePatchManifest, verifyPatchDirectory, sha256File} from '../src/update-manager.mjs';
import {Assistant} from '../src/wizard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const resources = path.join(root, 'src');

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'androidlink-appshell-')); }
function hash(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function mode(file) { return fs.statSync(file).mode & 0o777; }

function makePatch(root, from, to, rel, contents, sha = null) {
  const patch = path.join(root, 'patch');
  fs.mkdirSync(path.join(patch, 'payload', path.dirname(rel)), {recursive:true});
  const file = path.join(patch, 'payload', rel);
  fs.writeFileSync(file, contents, {mode:0o644});
  const component = JSON.parse(fs.readFileSync(path.join(resources,'component-manifest.json'),'utf8'));
  component.codeVersion = to;
  for (const module of Object.values(component.modules)) for (const entry of module.files) {
    if (entry.path === rel) {entry.sha256 = sha || hash(Buffer.from(contents));entry.bytes = Buffer.byteLength(contents);}
  }
  const componentText = JSON.stringify(component,null,2)+'\n';
  fs.writeFileSync(path.join(patch,'payload','component-manifest.json'),componentText,{mode:0o644});
  const manifest = {
    schemaVersion:1,
    productId:'local.androidlink.assistant',
    fromCodeVersions:[from],
    toCodeVersion:to,
    files:[
      {path:rel,sha256:sha || hash(Buffer.from(contents)),size:Buffer.byteLength(contents),mode:0o644},
      {path:'component-manifest.json',sha256:hash(Buffer.from(componentText)),size:Buffer.byteLength(componentText),mode:0o644},
    ],
  };
  fs.writeFileSync(path.join(patch,'patch-manifest.json'), JSON.stringify(manifest,null,2));
  return patch;
}

test('component manifest hashes every declared module file and separates app/code/runtime versions', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(resources,'component-manifest.json'),'utf8'));
  assert.equal(manifest.appVersion,'0.5.6');
  assert.equal(manifest.build,39);
  assert.equal(manifest.codeVersion,'0.5.6-build39');
  assert.equal(manifest.runtime.node,'22.16.0');
  assert.deepEqual(Object.keys(manifest.modules), ['shell','core','web','automation','mcp']);
  for (const module of Object.values(manifest.modules)) for (const entry of module.files) {
    const file = path.join(resources, entry.path);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false, entry.path);
    assert.equal(fs.statSync(file).size, entry.bytes, entry.path);
    assert.equal(sha256File(file), entry.sha256, entry.path);
  }
});

test('local component patch clones the active code, atomically switches pointer and can roll back', () => {
  const root = tmpRoot();
  try {
    const codeRoot = path.join(root,'modules','code');
    fs.mkdirSync(codeRoot,{recursive:true,mode:0o700});
    const from='0.5.4-build37', to='0.5.5-build38';
    fs.cpSync(resources,path.join(codeRoot,from),{recursive:true});
    fs.writeFileSync(path.join(root,'modules','active-code'),from+'\n',{mode:0o600});
    const old = fs.readFileSync(path.join(codeRoot,from,'control.js'),'utf8');
    const updated = old + '\n// patch-test\n';
    const patch = makePatch(root,from,to,'control.js',updated);
    const result = applyPatchDirectory(patch,{root});
    assert.equal(result.from,from); assert.equal(result.to,to); assert.equal(result.restartRequired,true);
    assert.equal(fs.readFileSync(path.join(root,'modules','active-code'),'utf8').trim(),to);
    assert.equal(fs.readFileSync(path.join(codeRoot,from,'control.js'),'utf8'),old,'active source must remain untouched');
    assert.equal(fs.readFileSync(path.join(codeRoot,to,'control.js'),'utf8'),updated);
    assert.equal(mode(path.join(root,'modules','active-code')),0o600);
    const rolled = rollbackCode({root});
    assert.equal(rolled.to,from);
    assert.equal(fs.readFileSync(path.join(root,'modules','active-code'),'utf8').trim(),from);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('patch validation rejects path traversal and bad hashes before active-code can change', () => {
  assert.throws(() => validatePatchManifest({schemaVersion:1,productId:'local.androidlink.assistant',fromCodeVersions:['a'],toCodeVersion:'b',files:[{path:'../evil',sha256:'0'.repeat(64),size:1},{path:'component-manifest.json',sha256:'0'.repeat(64),size:1}]}), /PATCH_PATH_INVALID/);
  const root=tmpRoot();
  try {
    const patch=makePatch(root,'a','b','control.js','x','0'.repeat(64));
    assert.throws(()=>verifyPatchDirectory(patch),/PATCH_HASH_MISMATCH/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('App daily session verification does not force Home while setup verification still can', async () => {
  const root=tmpRoot();
  const calls=[];
  const png=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.alloc(120)]).toString('base64');
  const helper=new Assistant(root,{http:async(_base,endpoint,method,body)=>{
    calls.push({endpoint,method,body});
    if(endpoint.endsWith('/source')) return '<hierarchy rotation="0"></hierarchy>';
    if(endpoint.endsWith('/screenshot')) return png;
    if(endpoint.endsWith('/window/rect')) return {x:0,y:0,width:1080,height:2400};
    return null;
  }});
  helper.base='http://127.0.0.1:4723';helper.session='session';
  try {
    await helper.verifySession({pressHome:false});
    assert.equal(calls.some(item=>item.endpoint.includes('/execute/sync')),false);
    assert.equal(helper.screenRect.width,1080);
    assert.equal(helper.actionLog.at(-1).value.home,false);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('App shell exits through the control page and maintenance scripts are explicit one-click entrypoints', () => {
  const html=fs.readFileSync(path.join(resources,'control.html'),'utf8');
  const browser=fs.readFileSync(path.join(resources,'control.js'),'utf8');
  const server=fs.readFileSync(path.join(resources,'control.mjs'),'utf8');
  assert.match(html,/id="quit"/);
  assert.match(browser,/\$\('quit'\)\.onclick/);
  assert.match(server,/route === '\/api\/quit'/);
  for (const name of ['install-from-package.command','open-assistant.command']) {
    const file=path.join(root,'scripts',name);assert.equal(fs.existsSync(file),true,name);assert.ok((fs.statSync(file).mode&0o111)!==0,name+' executable');
  }
  for (const name of ['安装本地更新包.command','清理旧版本.command','一键卸载安卓连接助手.command','高级维护与更换手机.command']) {
    const file=path.join(root,'scripts','maintenance',name);assert.equal(fs.existsSync(file),true,name);assert.ok((fs.statSync(file).mode&0o111)!==0,name+' executable');
  }
  const uninstall=fs.readFileSync(path.join(root,'scripts','maintenance','一键卸载安卓连接助手.command'),'utf8');
  assert.match(uninstall,/不会删除/);assert.match(uninstall,/AndroidLink截图/);assert.match(uninstall,/checkpoints/);
});


test('full installer atomically replaces the canonical App instead of installing versioned side-by-side copies', () => {
  const bootstrap=fs.readFileSync(path.join(resources,'bootstrap.zsh'),'utf8');
  assert.match(bootstrap, /APP_TARGET="\$HOME\/Applications\/安卓连接助手\.app"/);
  assert.match(bootstrap, /stop_running_assistant/);
  assert.match(bootstrap, /backups\/app-/);
  assert.match(bootstrap, /\/bin\/mv "\$APP_TARGET" "\$ARCHIVE_DIR\/安卓连接助手\.app"/);
  assert.match(bootstrap, /\/bin\/mv "\$APP_STAGE\/安卓连接助手\.app" "\$APP_TARGET"/);
  assert.doesNotMatch(bootstrap, /Applications\/安卓连接助手[-_ ]0\.5\.0\.app/);
});
