export const POLL_MS = 5000;

export function shouldPoll(status, enabled) {
  return enabled === true && status === 'incomplete';
}
