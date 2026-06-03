/** Case-(in)sensitive, non-overlapping substring search. Returns the start
 *  offsets of every match of `query` in `haystack`. Pure — unit-testable. */
export function findMatches(haystack: string, query: string, caseSensitive: boolean): number[] {
  if (!query) return [];
  const h = caseSensitive ? haystack : haystack.toLowerCase();
  const q = caseSensitive ? query : query.toLowerCase();
  const out: number[] = [];
  let i = h.indexOf(q);
  while (i !== -1) {
    out.push(i);
    i = h.indexOf(q, i + q.length);
  }
  return out;
}
