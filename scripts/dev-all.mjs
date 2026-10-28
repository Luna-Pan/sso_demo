#!/usr/bin/env node
/**
 * dev-all.mjs — 一键启动 Reely 本地开发所需的全部 7 个进程
 *   IdP (NestJS)         → http://localhost:4000
 *   BFF:mind             → 127.0.0.1:4001
 *   BFF:nexus            → 127.0.0.1:4002
 *   BFF:train            → 127.0.0.1:4003
 *   Vite:ReelyMind       → http://localhost:3001
 *   Vite:ReelyNexus      → http://localhost:3002
 *   Vite:ReelyTrain      → http://localhost:3003
 *
 * Windows 下直接 `node scripts/dev-all.mjs`（或根目录 `npm run dev:all`）。
 * Ctrl+C 会一次性杀死所有子进程。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const services = [
  {
    name: 'IdP',
    cwd: path.join(root, 'idp-server'),
    cmd: 'node',
    args: ['dist/main.js'],
    ready: (out) => out.includes('[IdP] Reely IdP started'),
    note: '首次使用前需 `npm run build --workspace idp-server`',
  },
  {
    name: 'BFF:mind',
    cwd: path.join(root, 'site-bff'),
    cmd: path.join(root, 'node_modules/.bin/tsx' + (process.platform === 'win32' ? '.cmd' : '')),
    args: ['src/index.ts', '--site=mind'],
    ready: (out) => out.includes('[BFF:mind]'),
  },
  {
    name: 'BFF:nexus',
    cwd: path.join(root, 'site-bff'),
    cmd: path.join(root, 'node_modules/.bin/tsx' + (process.platform === 'win32' ? '.cmd' : '')),
    args: ['src/index.ts', '--site=nexus'],
    ready: (out) => out.includes('[BFF:nexus]'),
  },
  {
    name: 'BFF:train',
    cwd: path.join(root, 'site-bff'),
    cmd: path.join(root, 'node_modules/.bin/tsx' + (process.platform === 'win32' ? '.cmd' : '')),
    args: ['src/index.ts', '--site=train'],
    ready: (out) => out.includes('[BFF:train]'),
  },
  {
    name: 'Vite:ReelyMind',
    cwd: path.join(root, 'web'),
    cmd: path.join(root, 'node_modules/.bin/vite' + (process.platform === 'win32' ? '.cmd' : '')),
    args: [],
    env: { ...process.env, BRAND: 'mind' },
    ready: (out) => out.includes('Local:') && out.includes(':3001'),
  },
  {
    name: 'Vite:ReelyNexus',
    cwd: path.join(root, 'web'),
    cmd: path.join(root, 'node_modules/.bin/vite' + (process.platform === 'win32' ? '.cmd' : '')),
    args: [],
    env: { ...process.env, BRAND: 'nexus' },
    ready: (out) => out.includes('Local:') && out.includes(':3002'),
  },
  {
    name: 'Vite:ReelyTrain',
    cwd: path.join(root, 'web'),
    cmd: path.join(root, 'node_modules/.bin/vite' + (process.platform === 'win32' ? '.cmd' : '')),
    args: [],
    env: { ...process.env, BRAND: 'train' },
    ready: (out) => out.includes('Local:') && out.includes(':3003'),
  },
];

const children = [];
const READY = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const WAIT = '\x1b[33m…\x1b[0m';

function pad(s, w = 16) {
  return (s + ' '.repeat(w)).slice(0, w);
}

function start(svc) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...(svc.env || {}) };
    const child = spawn(svc.cmd, svc.args, { cwd: svc.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    children.push(child);

    let ready = false;
    let buffer = '';
    const check = () => {
      if (!ready && svc.ready && svc.ready(buffer)) {
        ready = true;
        process.stdout.write(`${READY} ${pad(svc.name)}\x1b[0m ready (pid ${child.pid})\n`);
        resolve({ ok: true, child, name: svc.name });
      }
    };

    child.stdout.on('data', (d) => {
      const s = d.toString();
      buffer += s;
      check();
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      buffer += s;
      // 错误立即打印（tsx/vite 通常把错误也打到 stdout，但保险）
      const trimmed = s.trim();
      if (trimmed) process.stderr.write(`\x1b[2m${pad(svc.name)} err>\x1b[0m ${s}`);
      check();
    });
    child.on('exit', (code) => {
      if (!ready) {
        ready = true;
        process.stderr.write(`${FAIL} ${pad(svc.name)} exited early (code ${code})\n`);
        resolve({ ok: false, child, name: svc.name });
      }
    });

    // 15 秒超时
    setTimeout(() => {
      if (!ready) {
        ready = true;
        process.stderr.write(`${WAIT} ${pad(svc.name)} still booting after 15s (pid ${child.pid})\n`);
        resolve({ ok: true, child, name: svc.name, slow: true });
      }
    }, 15000);
  });
}

// 优雅退出
function cleanup(code = 0) {
  process.stdout.write(`\n\x1b[36m==> Killing ${children.length} child processes...\x1b[0m\n`);
  for (const c of children) {
    try { c.kill('SIGTERM'); } catch {}
  }
  // 兜底：500ms 后 SIGKILL
  setTimeout(() => {
    for (const c of children) {
      try { c.kill('SIGKILL'); } catch {}
    }
    process.exit(code);
  }, 800);
}
process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));
process.on('exit', () => cleanup(0));

async function main() {
  process.stdout.write('\n\x1b[1m=== Reely local dev — 7 services ===\x1b[0m\n\n');
  const results = [];
  for (const svc of services) {
    process.stdout.write(`${WAIT} ${pad(svc.name)} starting...`);
    const res = await start(svc);
    results.push(res);
  }
  const ok = results.filter((r) => r.ok).length;
  const slow = results.filter((r) => r.ok && r.slow).length;
  const fail = results.filter((r) => !r.ok).length;

  process.stdout.write(`\n\x1b[1m==> ${ok}/${services.length} ready`);
  if (slow) process.stdout.write(`, ${slow} slow boot`);
  if (fail) process.stdout.write(`, \x1b[31m${fail} FAIL\x1b[0m`);
  process.stdout.write('\x1b[0m\n\n');
  process.stdout.write('  IdP      http://localhost:4000\n');
  process.stdout.write('  Mind     http://localhost:3001\n');
  process.stdout.write('  Nexus    http://localhost:3002\n');
  process.stdout.write('  Train    http://localhost:3003\n\n');
  process.stdout.write('\x1b[2mCtrl+C to stop all.\x1b[0m\n\n');

  if (fail) cleanup(1);
}
main();
