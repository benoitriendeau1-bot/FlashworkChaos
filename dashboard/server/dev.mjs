import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const web = path.join(root, 'dashboard', 'web');
const children = [];
let stopping = false;

function launch(args, options) {
  const child = spawn(process.execPath, args, { stdio: 'inherit', ...options });
  children.push(child);
  child.on('exit', (code, signal) => {
    if (stopping) return;
    if (signal) return;
    stop(code || 0);
  });
  return child;
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode == null && !child.killed) child.kill();
  }
  setTimeout(() => process.exit(code), 300);
}

launch([path.join(root, 'dashboard', 'server', 'index.mjs')], {
  cwd: root,
  env: { ...process.env, CHAOS_DASHBOARD_HOST: '127.0.0.1', CHAOS_DASHBOARD_PORT: '4174' },
});
launch([path.join(web, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '4173', '--strictPort'], {
  cwd: web,
});

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
