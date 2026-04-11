/** Shared XML escaping and log truncation for DLNA / UPnP SOAP and DIDL. */

export function escapeXml(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function truncateLogSnippet(value: unknown, maxLength: number = 1800): string {
  const normalizedValue = String(value || '');
  if (normalizedValue.length <= maxLength) {
    return normalizedValue;
  }
  return `${normalizedValue.slice(0, maxLength)}…(truncated)`;
}
