import { reminderFourGrams, tokenizeReminderText } from "./tokenize.js";
import type { RankedReminder, ReminderDocument } from "./types.js";

interface Field {
  text: string;
  weight: number;
}

function frequency(tokens: readonly string[], term: string): number {
  let count = 0;
  for (const token of tokens) if (token === term) count += 1;
  return count;
}

function bm25Field(
  documents: readonly ReminderDocument[],
  query: readonly string[],
  select: (document: ReminderDocument) => string,
): number[] {
  const tokenized = documents.map((document) => tokenizeReminderText(select(document)));
  const average =
    tokenized.reduce((sum, tokens) => sum + tokens.length, 0) / Math.max(1, tokenized.length);
  const documentFrequency = new Map<string, number>();
  for (const tokens of tokenized) {
    for (const term of new Set(tokens))
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  return tokenized.map((tokens) => {
    let score = 0;
    for (const term of new Set(query)) {
      const containing = documentFrequency.get(term) ?? 0;
      if (containing === 0) continue;
      const idf = Math.log(1 + (documents.length - containing + 0.5) / (containing + 0.5));
      const tf = frequency(tokens, term);
      const denominator = tf + 1.2 * (1 - 0.75 + 0.75 * (tokens.length / Math.max(1, average)));
      score += idf * ((tf * 2.2) / denominator);
    }
    return score;
  });
}

export function rankReminderDocuments(
  documents: readonly ReminderDocument[],
  queryText: string,
  options: { includeCitations?: boolean } = {},
): RankedReminder[] {
  if (documents.length === 0) return [];
  const query = tokenizeReminderText(queryText);
  if (query.length === 0) return [];
  const fields: Array<(document: ReminderDocument) => Field> = [
    (document) => ({ text: `${document.title} ${document.hook}`, weight: 4 }),
    (document) => ({ text: document.description, weight: 3 }),
    (document) => ({
      text: options.includeCitations === false ? "" : document.citations.join(" "),
      weight: 2.5,
    }),
    (document) => ({ text: document.body, weight: 1 }),
  ];
  const scores = documents.map(() => 0);
  for (const field of fields) {
    const values = documents.map((document) => field(document));
    const partial = bm25Field(documents, query, (document) => field(document).text);
    partial.forEach((score, index) => {
      scores[index] = (scores[index] ?? 0) + score * (values[index]?.weight ?? 1);
    });
  }

  const querySet = new Set(query);
  const queryGrams = new Set(reminderFourGrams(queryText));
  const best = new Map<string, RankedReminder>();
  documents.forEach((document, index) => {
    let score = scores[index] ?? 0;
    for (const identifier of document.identifiers) {
      const tokens = tokenizeReminderText(identifier);
      if (tokens.some((token) => querySet.has(token))) score += 6;
    }
    if (score === 0 && queryGrams.size > 0) {
      const grams = new Set(
        reminderFourGrams(`${document.title} ${document.hook} ${document.description}`),
      );
      let overlap = 0;
      for (const gram of queryGrams) if (grams.has(gram)) overlap += 1;
      score += overlap * 0.2;
    }
    if (score <= 0) return;
    const ranked = { document, score };
    const previous = best.get(document.canonicalKey);
    if (previous === undefined || previous.score < score) best.set(document.canonicalKey, ranked);
  });
  return [...best.values()].sort(
    (left, right) => right.score - left.score || left.document.id.localeCompare(right.document.id),
  );
}
