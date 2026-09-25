export function createSearchDelay(apply, wait = 300, { schedule = setTimeout, cancel = clearTimeout } = {}) {
  let timer = null;
  return {
    push(value) {
      if (timer != null) cancel(timer);
      timer = schedule(() => {
        timer = null;
        apply(value);
      }, wait);
    },
    cancel() {
      if (timer != null) cancel(timer);
      timer = null;
    },
  };
}
