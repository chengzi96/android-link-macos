import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {safeChild} from './core.mjs';

function hashBuffer(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function safeName(value) {
  const clean = String(value || '检查点').replace(/[\\/:*?"<>|\r\n\t]/g, ' ').replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}._-]/gu, '').slice(0, 60);
  return clean || '检查点';
}
function stamp(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth()+1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
function displayPath(file) {
  const home = os.homedir();
  return file === home ? '~' : file.startsWith(home + path.sep) ? '~' + file.slice(home.length) : file;
}
function writeSecure(file, data) {
  fs.writeFileSync(file, data, {flag: 'wx', mode: 0o600});
  return {name: path.basename(file), sha256: hashBuffer(Buffer.isBuffer(data) ? data : Buffer.from(data)), bytes: Buffer.byteLength(data)};
}

export class CheckpointStore {
  constructor(root) {
    this.aiRoot = path.join(root, 'ai');
    this.root = path.join(this.aiRoot, 'checkpoints');
  }

  save({name, png, xml, snapshot, runtimeSpec, metadata = {}}) {
    fs.mkdirSync(this.aiRoot, {recursive: true, mode: 0o700});
    const aiInfo = fs.lstatSync(this.aiRoot);
    if (!aiInfo.isDirectory() || aiInfo.isSymbolicLink()) throw new Error('检查点父目录不安全。');
    fs.mkdirSync(this.root, {recursive: true, mode: 0o700});
    const rootInfo = fs.lstatSync(this.root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('检查点目录不安全。');
    fs.chmodSync(this.aiRoot, 0o700);fs.chmodSync(this.root, 0o700);
    let directory;
    for (let i = 0; i < 100; i++) {
      const candidate = safeChild(this.root, path.join(this.root, `${stamp()}_${safeName(name)}${i ? '_' + (i+1) : ''}`));
      try { fs.mkdirSync(candidate, {mode: 0o700}); directory = candidate; break; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    if (!directory) throw new Error('无法创建检查点目录。');
    const screenshot = writeSecure(path.join(directory, 'screen.png'), png);
    const page = writeSecure(path.join(directory, 'page.xml'), String(xml || ''));
    const snapshotFile = writeSecure(path.join(directory, 'snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n');
    let runtime = null;
    if (runtimeSpec) runtime = writeSecure(path.join(directory, 'runtime-spec.json'), JSON.stringify(runtimeSpec, null, 2) + '\n');
    const manifest = {
      manifestVersion: 1,
      createdAt: new Date().toISOString(),
      name: safeName(name),
      files: {screenshot, page, snapshot: snapshotFile, ...(runtime ? {runtimeSpec: runtime} : {})},
      runtimeSpecAvailable: Boolean(runtime),
      metadata,
    };
    const manifestFile = writeSecure(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return {directory: displayPath(directory), manifestPath: displayPath(path.join(directory, 'manifest.json')), manifestSha256: manifestFile.sha256, files: manifest.files};
  }
}

export {displayPath, hashBuffer, safeName};
