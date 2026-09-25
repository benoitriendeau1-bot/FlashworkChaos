export function httpError(status, code, message, details) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  return error;
}

export function sendError(response, error, log) {
  const status = error.status || 500;
  const body = {
    error: true,
    code: status === 500 ? 'internal' : error.code || 'error',
    message: status === 500 ? 'Unexpected server error' : error.message,
  };
  if (status !== 500 && error.details) body.details = error.details;
  if (status === 500 && log) log('error', error.message);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

export function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
