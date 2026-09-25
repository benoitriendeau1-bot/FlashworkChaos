export function reproductionCommand(run) {
  const seed = run?.seed == null || run.seed === '' ? '<seed>' : String(run.seed);
  const po = Number.isInteger(run?.po) && run.po > 0 ? run.po : 1;
  return `npm start -- --seed=${seed} --po=${po} --run-id=<nouvel-id>`;
}
