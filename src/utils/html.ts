/**
 * HTML escaping for values interpolated into template-literal markup.
 *
 * The UI components build their markup as strings and assign it to innerHTML.
 * Document names, folder names, bookmark titles and extracted page text all
 * originate from files the user opens, so they must be escaped before they are
 * embedded - both to render names like "a<b>.pdf" correctly and to keep file
 * content from injecting markup into a privileged extension page.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
