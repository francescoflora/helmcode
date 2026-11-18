export type WordOccurrence = { from: number; to: number; main: boolean };

/** Find whole-word occurrences without matching substrings inside other identifiers. */
export function findWordOccurrences(
  text: string,
  query: string,
  isWord: (char: string) => boolean,
  mainFrom: number,
  limit = 1000,
): WordOccurrence[] {
  if (!query) return [];
  const occurrences: WordOccurrence[] = [];
  let index = 0;
  while (index <= text.length - query.length) {
    const from = text.indexOf(query, index);
    if (from < 0) break;
    const to = from + query.length;
    const before = from === 0 ? "" : text[from - 1];
    const after = to === text.length ? "" : text[to];
    if (!(before && isWord(before)) && !(after && isWord(after))) {
      occurrences.push({ from, to, main: from === mainFrom });
      if (occurrences.length > limit) return [];
    }
    index = to;
  }
  return occurrences;
}
