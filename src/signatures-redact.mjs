const SECRET_KEYS = new Set(['password', 'identifier', 'email', 'token', 'secret']);

/** Replace credential fields before a body is hashed, journaled, or copied into a finding. */
export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (!value || typeof value !== 'object') return value;
  const redacted = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEYS.has(key) && item != null && item !== '') redacted[key] = '[REDACTED]';
    else redacted[key] = redactSecrets(item);
  }
  return redacted;
}

export function containsSecret(value) {
  const serialized = JSON.stringify(value);
  return serialized.includes('"password"')
    || /"password"\s*:/.test(serialized)
    || (typeof value === 'string' && /password|changeme/i.test(value));
}
