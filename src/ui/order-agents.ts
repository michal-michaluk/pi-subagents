/**
 * order-agents.ts — Stable ordering of agent records for the fleet views.
 *
 * The base list from `listAgents()` is ordered purely by start time, which
 * puts a gated-run `Review` agent (spawned after its task settles) at the
 * top of a newest-first view, above the task it reviewed. This places each
 * review immediately after the task agent whose id equals its `reviewOf`.
 */

/**
 * Stable-sort a base-ordered list so that a record with `reviewOf === X`
 * sorts immediately after the record with id === X, task first then its
 * review. Groups otherwise keep their relative base order, and records with
 * no `reviewOf`/no matching task keep their position.
 */
export function orderAgentsByReview<T extends { id: string; reviewOf?: string }>(records: T[]): T[] {
  const reviewsByTarget = new Map<string, T[]>();
  for (const record of records) {
    if (record.reviewOf) {
      const list = reviewsByTarget.get(record.reviewOf) ?? [];
      list.push(record);
      reviewsByTarget.set(record.reviewOf, list);
    }
  }

  const ordered: T[] = [];
  const placed = new Set<T>();
  for (const record of records) {
    if (record.reviewOf) continue; // placed when its task is reached
    ordered.push(record);
    placed.add(record);
    for (const review of reviewsByTarget.get(record.id) ?? []) {
      if (!placed.has(review)) {
        ordered.push(review);
        placed.add(review);
      }
    }
  }
  // A review whose task was evicted before render (no record with that id):
  // append it rather than dropping it from the view.
  for (const record of records) {
    if (record.reviewOf && !placed.has(record)) ordered.push(record);
  }
  return ordered;
}
