import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const UPDATE_SCHEMA_VERSION = 1;
export const PRODUCT_ID = 'local.androidlink.assistant';
const MAX_PATCH_FILES = 256;
const MAX_PATCH_BYTES = 64 * 1024 * 1024;

export function defaultRoot() {
  return process.env.ANDROID_LINK_ROOT || path.join(os.homedir(), 'Library', 'Application Support', 'AndroidLink');
}

export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buf, 0, buf.length, null);
      if (!read) break;
      hash.update(buf.subarray(0, read));
    }
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

export function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 240 || value.includes('\\') || value.includes('\0')) throw new Error('PATCH_PATH_INVALID');
  if (path.isAbsolute(value)) throw new Error('PATCH_PATH_INVALID');
  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../') || normalized !== value) throw new Error('PATCH_PATH_INVALID');
  if (!/^[\p{L}\p{N}._+\-/]+$/u.test(value)) throw new Error('PATCH_PATH_INVALID');
  return value;
}

export function validatePatchManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('PATCH_MANIFEST_INVALID');
  if (manifest.schemaVersion !== UPDATE_SCHEMA_VERSION) throw new Error('PATCH_SCHEMA_UNSUPPORTED');
  if (manifest.productId !== PRODUCT_ID) throw new Error('PATCH_PRODUCT_MISMATCH');
  if (!Array.isArray(manifest.fromCodeVersions) || !manifest.fromCodeVersions.length || manifest.fromCodeVersions.length > 32) throw new Error('PATCH_MANIFEST_INVALID');
  if (!manifest.fromCodeVersions.every(v => typeof v === 'string' && /^[0-9A-Za-z._+-]{1,64}$/.test(v))) throw new Error('PATCH_MANIFEST_INVALID');
  if (typeof manifest.toCodeVersion !== 'string' || !/^[0-9A-Za-z._+-]{1,64}$/.test(manifest.toCodeVersion)) throw new Error('PATCH_MANIFEST_INVALID');
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > MAX_PATCH_FILES) throw new Error('PATCH_MANIFEST_INVALID');
  if (!manifest.files.some(entry => entry?.path === 'component-manifest.json')) throw new Error('PATCH_COMPONENT_MANIFEST_REQUIRED');
  let total = 0;
  const seen = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry !== 'object') throw new Error('PATCH_MANIFEST_INVALID');
    const rel = safeRelativePath(entry.path);
    if (seen.has(rel)) throw new Error('PATCH_DUPLICATE_PATH');
    seen.add(rel);
    if (!/^[a-f0-9]{64}$/.test(String(entry.sha256 || ''))) throw new Error('PATCH_HASH_INVALID');
    if (!Number.isInteger(entry.size) || entry.size < 0 || entry.size > MAX_PATCH_BYTES) throw new Error('PATCH_SIZE_INVALID');
    total += entry.size;
    if (total > MAX_PATCH_BYTES) throw new Error('PATCH_TOO_LARGE');
    if (entry.mode !== undefined && ![0o600,0o644,0o700,0o755].includes(entry.mode)) throw new Error('PATCH_MODE_INVALID');
  }
  return manifest;
}

function assertSafeDirectory(dir, label) {
  const info = fs.lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(label + '_UNSAFE');
}

function readActiveCode(root) {
  const pointer = path.join(root, 'modules', 'active-code');
  const value = fs.readFileSync(pointer, 'utf8').trim();
  if (!/^[0-9A-Za-z._+-]{1,64}$/.test(value)) throw new Error('ACTIVE_CODE_INVALID');
  const dir = path.join(root, 'modules', 'code', value);
  assertSafeDirectory(dir, 'ACTIVE_CODE');
  return {value, dir, pointer};
}

function writeAtomic(file, contents, mode = 0o600) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, {recursive:true, mode:0o700});
  const temp = path.join(dir, '.' + path.basename(file) + '.tmp-' + crypto.randomUUID());
  fs.writeFileSync(temp, contents, {mode, flag:'wx'});
  fs.renameSync(temp, file);
  fs.chmodSync(file, mode);
}

function validateCodeTree(dir, expectedCodeVersion = null) {
  for (const required of ['core.mjs','wizard.mjs','control.mjs','control.js','control.html','automation-service.mjs','mcp-server.mjs','component-manifest.json']) {
    const file = path.join(dir, required);
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('PATCH_REQUIRED_RESOURCE_MISSING:' + required);
  }
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.mjs')) continue;
    const result = spawnSync(process.execPath, ['--check', path.join(dir, name)], {encoding:'utf8', timeout:15000});
    if (result.status !== 0) throw new Error('PATCH_SYNTAX_INVALID:' + name);
  }
  const component = JSON.parse(fs.readFileSync(path.join(dir,'component-manifest.json'),'utf8'));
  if (component.productId !== PRODUCT_ID || !component.modules || typeof component.modules !== 'object') throw new Error('COMPONENT_MANIFEST_INVALID');
  if (expectedCodeVersion && component.codeVersion !== expectedCodeVersion) throw new Error('COMPONENT_VERSION_MISMATCH');
  for (const module of Object.values(component.modules)) {
    if (!module || !Array.isArray(module.files)) throw new Error('COMPONENT_MANIFEST_INVALID');
    for (const entry of module.files) {
      const rel = safeRelativePath(entry.path), file = path.join(dir, ...rel.split('/'));
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('COMPONENT_FILE_UNSAFE:' + rel);
      if (Number(entry.bytes) !== info.size || String(entry.sha256) !== sha256File(file)) throw new Error('COMPONENT_HASH_MISMATCH:' + rel);
    }
  }
  return component;
}

export function verifyPatchDirectory(patchDir) {
  const root = path.resolve(patchDir);
  assertSafeDirectory(root, 'PATCH_DIRECTORY');
  const manifestPath = path.join(root, 'patch-manifest.json');
  const payloadRoot = path.join(root, 'payload');
  const manifestInfo = fs.lstatSync(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new Error('PATCH_MANIFEST_UNSAFE');
  assertSafeDirectory(payloadRoot, 'PATCH_PAYLOAD');
  const manifest = validatePatchManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  for (const entry of manifest.files) {
    const rel = safeRelativePath(entry.path);
    const file = path.join(payloadRoot, ...rel.split('/'));
    const resolved = path.resolve(file);
    if (!resolved.startsWith(path.resolve(payloadRoot) + path.sep)) throw new Error('PATCH_PATH_ESCAPE');
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('PATCH_FILE_UNSAFE:' + rel);
    if (info.size !== entry.size) throw new Error('PATCH_SIZE_MISMATCH:' + rel);
    if (sha256File(file) !== entry.sha256) throw new Error('PATCH_HASH_MISMATCH:' + rel);
  }
  return {manifest, payloadRoot};
}

export function applyPatchDirectory(patchDir, options = {}) {
  const root = options.root || defaultRoot();
  const modulesRoot = path.join(root, 'modules');
  assertSafeDirectory(modulesRoot, 'MODULES_ROOT');
  const {manifest, payloadRoot} = verifyPatchDirectory(patchDir);
  const active = readActiveCode(root);
  if (!manifest.fromCodeVersions.includes(active.value)) throw new Error('PATCH_SOURCE_VERSION_MISMATCH');
  const codeRoot = path.join(modulesRoot, 'code');
  assertSafeDirectory(codeRoot, 'CODE_ROOT');
  const targetDir = path.join(codeRoot, manifest.toCodeVersion);
  if (fs.existsSync(targetDir)) throw new Error('PATCH_TARGET_EXISTS');
  const stageDir = path.join(codeRoot, '.stage-' + crypto.randomUUID());
  const updateDir = path.join(root, 'updates');
  fs.mkdirSync(updateDir, {recursive:true, mode:0o700});
  const lock = path.join(updateDir, 'update.lock');
  let lockFd;
  try { lockFd = fs.openSync(lock, 'wx', 0o600); } catch { throw new Error('UPDATE_ALREADY_RUNNING'); }
  try {
    fs.cpSync(active.dir, stageDir, {recursive:true, errorOnExist:true, force:false, dereference:false});
    assertSafeDirectory(stageDir, 'PATCH_STAGE');
    for (const entry of manifest.files) {
      const rel = safeRelativePath(entry.path);
      const source = path.join(payloadRoot, ...rel.split('/'));
      const dest = path.join(stageDir, ...rel.split('/'));
      const parent = path.dirname(dest);
      fs.mkdirSync(parent, {recursive:true, mode:0o700});
      if (fs.existsSync(dest)) {
        const info = fs.lstatSync(dest);
        if (info.isSymbolicLink() || !info.isFile()) throw new Error('PATCH_DEST_UNSAFE:' + rel);
      }
      fs.copyFileSync(source, dest);
      fs.chmodSync(dest, entry.mode ?? 0o644);
      if (sha256File(dest) !== entry.sha256) throw new Error('PATCH_COPY_VERIFY_FAILED:' + rel);
    }
    validateCodeTree(stageDir, manifest.toCodeVersion);
    fs.renameSync(stageDir, targetDir);
    writeAtomic(path.join(modulesRoot, 'previous-code'), active.value + '\n');
    writeAtomic(active.pointer, manifest.toCodeVersion + '\n');
    writeAtomic(path.join(updateDir, 'last-update.json'), JSON.stringify({at:new Date().toISOString(),from:active.value,to:manifest.toCodeVersion},null,2)+'\n');
    return {from:active.value,to:manifest.toCodeVersion,restartRequired:true};
  } catch (error) {
    try { if (fs.existsSync(stageDir) && !fs.lstatSync(stageDir).isSymbolicLink()) fs.rmSync(stageDir,{recursive:true,force:true}); } catch {}
    throw error;
  } finally {
    try { fs.closeSync(lockFd); } catch {}
    try { fs.unlinkSync(lock); } catch {}
  }
}

export function rollbackCode(options = {}) {
  const root = options.root || defaultRoot();
  const modulesRoot = path.join(root, 'modules');
  const previousFile = path.join(modulesRoot, 'previous-code');
  const previous = fs.readFileSync(previousFile, 'utf8').trim();
  if (!/^[0-9A-Za-z._+-]{1,64}$/.test(previous)) throw new Error('ROLLBACK_VERSION_INVALID');
  const previousDir = path.join(modulesRoot, 'code', previous);
  assertSafeDirectory(previousDir, 'ROLLBACK_CODE');
  const active = readActiveCode(root);
  writeAtomic(active.pointer, previous + '\n');
  writeAtomic(previousFile, active.value + '\n');
  return {from:active.value,to:previous,restartRequired:true};
}

async function main() {
  const [command, value] = process.argv.slice(2);
  if (command === 'verify' && value) {
    const {manifest} = verifyPatchDirectory(value);
    process.stdout.write(JSON.stringify({ok:true,toCodeVersion:manifest.toCodeVersion})+'\n');
    return;
  }
  if (command === 'apply' && value) {
    process.stdout.write(JSON.stringify({ok:true,...applyPatchDirectory(value)})+'\n');
    return;
  }
  if (command === 'rollback') {
    process.stdout.write(JSON.stringify({ok:true,...rollbackCode()})+'\n');
    return;
  }
  process.stderr.write('用法：update-manager.mjs verify <patch目录> | apply <patch目录> | rollback\n');
  process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  process.stderr.write(String(error?.message || error) + '\n');
  process.exitCode = 1;
});
