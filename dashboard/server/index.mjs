import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_HOST, DEFAULT_PORT } from '../shared/constants.mjs';
import { createCache } from './cache.mjs';
import { handleRequest } from './routes.mjs';
import { createRunStore, resolveRunsRoot } from './run-store.mjs';

export const defaultWebRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function logicalRunsLabel(runsRoot) {
  const relative = path.relative(repoRoot, path.resolve(runsRoot));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return 'custom';
  return relative.split(path.sep).join('/');
}

export function dashboardConfig(env = process.env, argv = process.argv.slice(2)) {
  const flags = {};
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) flags[match[1]] = match[2];
  }
  const host = flags.host || env.CHAOS_DASHBOARD_HOST || DEFAULT_HOST;
  const port = Number(flags.port || env.CHAOS_DASHBOARD_PORT || DEFAULT_PORT);
  const runsRoot = path.resolve(flags.runs || env.CHAOS_DASHBOARD_RUNS || path.join(repoRoot, 'runs'));
  const logLevel = flags.log || env.CHAOS_DASHBOARD_LOG || 'info';
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Dashboard port is invalid');
  }
  const webRoot = flags.web === '' || env.CHAOS_DASHBOARD_WEB === ''
    ? null
    : path.resolve(flags.web || env.CHAOS_DASHBOARD_WEB || defaultWebRoot);
  return { host, port, runsRoot, logLevel, webRoot };
}

export function startDashboard(config) {
  const cache = createCache();
  const store = createRunStore({ runsRoot: config.runsRoot, cache });
  const log = (level, message) => {
    const ranks = { silent: 0, error: 1, info: 2 };
    if ((ranks[config.logLevel] ?? 2) >= (ranks[level] ?? 2)) console.error(`[dashboard] ${message}`);
  };
  const server = http.createServer((request, response) => {
    const webRoot = Object.prototype.hasOwnProperty.call(config, 'webRoot') ? config.webRoot : defaultWebRoot;
    handleRequest(request, response, { store, runsLabel: logicalRunsLabel(config.runsRoot), log, webRoot });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      const address = server.address();
      resolve({
        server,
        host: address.address,
        port: address.port,
        cache,
        close() {
          return new Promise((done, fail) => server.close((error) => error ? fail(error) : done()));
        },
      });
    });
  });
}

const launchedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (launchedDirectly) {
  const config = dashboardConfig();
  resolveRunsRoot(config.runsRoot);
  const dashboard = await startDashboard(config);
  console.log(`FlashWorkChaos dashboard listening on http://${dashboard.host}:${dashboard.port}`);
  const stop = () => {
    dashboard.close().then(() => process.exit(0), () => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
