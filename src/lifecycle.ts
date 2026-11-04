/** One owner's lifecycle fence; no process-global revision. */
export function createLifecycleRevision() {
  let revision = 0;
  return { current: () => revision, invalidate: () => { revision++; } };
}
