/**
 * Turns literal \\uXXXX sequences (sometimes emitted by models instead of Unicode) into real characters.
 */
export function decodeJsonStyleUnicodeEscapes(text: string): string {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}
