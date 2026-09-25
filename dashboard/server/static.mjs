import fs from 'node:fs';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const UNBUILT = 'FlashWorkChaos dashboard server is running. Web UI is not built. Run npm run dashboard:build.\n';

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolveWebFile(webRoot, pathname) {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { error: 400 };
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return { error: 400 };
  const parts = decoded.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) return { error: 400 };
  const root = fs.realpathSync(webRoot);
  const candidate = path.resolve(root, ...parts);
  if (!inside(root, candidate)) return { error: 400 };
  return { root, candidate, parts };
}

function cacheControl(relativeParts, filePath) {
  if (path.basename(filePath) === 'index.html' || relativeParts.length === 0) return 'no-cache';
  if (relativeParts[0] === 'assets') return 'public, max-age=31536000, immutable';
  return 'no-cache';
}

function sendFile(response, method, file, type, cache) {
  const stat = fs.statSync(file);
  response.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'cache-control': cache,
    'x-content-type-options': 'nosniff',
  });
  if (method === 'HEAD') {
    response.end();
    return;
  }
  fs.createReadStream(file).pipe(response);
}

function sendText(response, status, body, method) {
  const payload = method === 'HEAD' ? '' : body;
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(method === 'HEAD' ? body : payload),
  });
  response.end(payload);
}

export function serveWeb(request, response, webRoot) {
  const url = new URL(request.url, 'http://127.0.0.1');
  const indexReady = webRoot && fs.existsSync(path.join(webRoot, 'index.html'));
  if (!indexReady) {
    if (url.pathname === '/') {
      sendText(response, 200, UNBUILT, request.method);
      return true;
    }
    sendText(response, 404, 'Not found\n', request.method);
    return true;
  }
  const located = resolveWebFile(webRoot, url.pathname);
  if (located.error) {
    sendText(response, located.error, 'Not found\n', request.method);
    return true;
  }
  const indexFile = path.join(located.root, 'index.html');
  let file = located.parts.length === 0 ? indexFile : located.candidate;
  let stat = null;
  try {
    stat = fs.lstatSync(file);
  } catch {
    stat = null;
  }
  if (stat?.isSymbolicLink()) {
    let real;
    try {
      real = fs.realpathSync(file);
    } catch {
      real = null;
    }
    if (!real || !inside(located.root, real)) {
      sendText(response, 400, 'Not found\n', request.method);
      return true;
    }
    file = real;
    stat = fs.statSync(file);
  }
  if (stat?.isDirectory()) {
    sendText(response, 404, 'Not found\n', request.method);
    return true;
  }
  if (!stat?.isFile()) {
    const asset = located.parts[0] === 'assets' || path.extname(url.pathname);
    if (asset) {
      sendText(response, 404, 'Not found\n', request.method);
      return true;
    }
    file = indexFile;
  }
  const type = TYPES[path.extname(file)] || 'application/octet-stream';
  sendFile(response, request.method, file, type, cacheControl(file === indexFile ? [] : located.parts, file));
  return true;
}
