const POLISH_FOLD: Readonly<Record<string, string>> = {
  ą: "a",
  ć: "c",
  ę: "e",
  ł: "l",
  ń: "n",
  ó: "o",
  ś: "s",
  ź: "z",
  ż: "z",
};

export function foldReminderText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[ąćęłńóśźż]/g, (character) => POLISH_FOLD[character] ?? character);
}

export function tokenizeReminderText(value: string): string[] {
  const folded = foldReminderText(value);
  const whole = folded.match(/[a-z0-9]+(?:[._/@:-][a-z0-9]+)+/g) ?? [];
  const words = folded.match(/[a-z0-9]+/g) ?? [];
  return [...whole, ...words].filter((token) => token.length > 1);
}

export function reminderFourGrams(value: string): string[] {
  const normalized = foldReminderText(value)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const grams: string[] = [];
  for (const word of normalized.split(/\s+/)) {
    if (word.length < 4) continue;
    for (let index = 0; index <= word.length - 4; index += 1)
      grams.push(word.slice(index, index + 4));
  }
  return grams;
}
