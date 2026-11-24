const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '/': '&#x2F;',
};

/**
 * Escape a value for interpolation into HTML text or a quoted attribute.
 *
 * The single server-side HTML escaper — use it for every untrusted value put
 * into server-rendered HTML (emails, the log viewers) rather than adding
 * another copy. Accepts any value: callers often pass parsed JSON, where a
 * field typed as a number may hold an arbitrary string at runtime.
 * null/undefined become the empty string.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"'/]/g, (char) => HTML_ESCAPES[char]);
}
