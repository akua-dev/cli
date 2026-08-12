export function encodeForm(fields: Readonly<Record<string, string>>): string {
  return new URLSearchParams(fields).toString();
}
