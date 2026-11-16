#!/usr/bin/env node
/**
 * dev-all.mjs — 一键启动 SSO 本地开发所需的全部 7 个进程
 *   IdP (NestJS)         → http://localhost:4000
 *   BFF:a                → 127.0.0.1:4001
 *   BFF:b                → 127.0.0.1:4002
 *   BFF:c                → 127.0.0.1:4003
 *   Vite:A               → http://localhost:3001
 *   Vite:B               → http://localhost:3002
 *   Vite:C               → http://localhost:3003
 *
 * Windows 下直接 `node scripts/dev-all.mjs`（或根目录 `npm run dev:all`）。
 * Ctrl+C 会一次性杀死所有子进程。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// 读取根目录 .env.local（若存在）并注入 process.env —— 子进程通过 {...process.env} 继承，
// 使 IdP/BFF 的 SITE_*_ORIGIN、IDP_ISSUER 等覆盖项对整套本地栈生效。已存在的环境变量优先。
const envLocal = path.join(root, '.env.local');
if (existsSync(envLocal)) {
  for (const raw of readFileSync(envLocal, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  process.stdout.write(`\x1b[2m[dev-all] loaded ${path.basename(envLocal)}\x1b[0m\n`);
}

const services = [
  {
    name: 'IdP',
    cwd: path.join(root, 'idp-server'),
    cmd: 'node',
    args: ['dist/main.js'],
    ready: (out) => out.includes('[IdP] SSO IdP started'),
    note: '首次使用前需 `npm run build --workspace idp-server`',
  },
  {
    name: 'BFF:a',
    cwd: path.join(root, 'site-bff'),
    cmd: path.join(root, 'node_modules/.bin/tsx' + (process.platform === 'win32' ? '.cmd' : '')),
    args: ['src/index.ts', '--site=a'],
    ready: (out) => out.includes('[BFF:a]'),
  },
  {
    name: 'BFF:b',
    cwd: path.join(root, 'site-bff'),
    cmd: path.join(root, 'node_modules/.bin/tsx' + (process.platform === 'win32' ? '.cmd' : '')),
    args: ['src/index.ts', '--site=b'],
    ready: (out) => out.includes('[BFF:b]'),
  },
  {
    name: 'BFF:c',
    cwd: path.join(root, 'site-bff'),
    cmd: path.join(root, 'node_modules/.bin/tsx' + (process.platform === 'win32' ? '.cmd' : '')),
    args: ['src/index.ts', '--site=c'],
    ready: (out) => out.includes('[BFF:c]'),
  },
  {
    name: 'Vite:A',
    cwd: path.join(root, 'web'),
    cmd: path.join(root, 'node_modules/.bin/vite' + (process.platform === 'win32' ? '.cmd' : '')),
    args: [],
    env: { ...process.env, BRAND: 'a' },
    ready: (out) => out.includes('Local:') && out.includes(':3001'),
  },
  {
    name: 'Vite:B',
    cwd: path.join(root, 'web'),
    cmd: path.join(root, 'node_modules/.bin/vite' + (process.platform === 'win32' ? '.cmd' : '')),
    args: [],
    env: { ...process.env, BRAND: 'b' },
    ready: (out) => out.includes('Local:') && out.includes(':3002'),
  },
  {
    name: 'Vite:C',
    cwd: path.join(root, 'web'),
    cmd: path.join(root, 'node_modules/.bin/vite' + (process.platform === 'win32' ? '.cmd' : '')),
    args: [],
    env: { ...process.env, BRAND: 'c' },
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
  process.stdout.write('\n\x1b[1m=== SSO local dev — 7 services ===\x1b[0m\n\n');
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
  process.stdout.write('  A        http://localhost:3001\n');
  process.stdout.write('  B        http://localhost:3002\n');
  process.stdout.write('  C        http://localhost:3003\n\n');
  process.stdout.write('\x1b[2mCtrl+C to stop all.\x1b[0m\n\n');

  if (fail) cleanup(1);
}
main();
