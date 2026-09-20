/** Replace control characters in untrusted process/server text without a control-character regex. */
export function replaceControlCharacters(value: string, replacement = " "): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? replacement : character;
    })
    .join("");
}
