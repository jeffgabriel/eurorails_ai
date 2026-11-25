import { escapeHtml } from '../utils/escapeHtml';

describe('escapeHtml', () => {
  it('escapes every HTML-significant character', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#x27;y&#x27;&gt;&amp;&lt;&#x2F;a&gt;',
    );
  });

  it('does not double-unescape: an already-escaped entity is escaped again', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('stringifies non-string values', () => {
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(false)).toBe('false');
  });

  it('renders null and undefined as the empty string', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});
