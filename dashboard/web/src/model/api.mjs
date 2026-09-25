export function assertLocalApi(path) {
  if (typeof path !== 'string' || !path.startsWith('/api/')) {
    throw Object.assign(new Error('Dashboard client only calls /api'), { code: 'refused_target', status: 0 });
  }
}

export async function apiGet(path, { signal, fetchImpl = globalThis.fetch } = {}) {
  assertLocalApi(path);
  let response;
  try {
    response = await fetchImpl(path, { method: 'GET', signal, headers: { accept: 'application/json' } });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw Object.assign(new Error('Dashboard API is not reachable'), { code: 'unavailable', status: 0 });
  }
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { message: 'Response was not JSON' };
  }
  if (!response.ok) {
    throw Object.assign(new Error(body?.message || 'Request failed'), {
      status: response.status,
      code: body?.code || 'error',
      details: body?.details,
    });
  }
  return body;
}

export function createClient(fetchImpl = globalThis.fetch) {
  const controllers = new Map();
  return {
    async get(path) {
      const key = path.split('?')[0];
      controllers.get(key)?.abort();
      const controller = new AbortController();
      controllers.set(key, controller);
      try {
        return await apiGet(path, { signal: controller.signal, fetchImpl });
      } finally {
        if (controllers.get(key) === controller) controllers.delete(key);
      }
    },
  };
}
