/**
 * Copies text to the clipboard. The asynchronous clipboard exists only in
 * secure contexts, so plain-HTTP deployments fall back to a hidden textarea.
 */
export async function copyText(text: string): Promise<boolean> {
  const clipboard = navigator.clipboard as Clipboard | undefined;
  if (clipboard) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or the document is not focused: try the fallback.
    }
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  try {
    // Deprecated, and the only way to copy outside a secure context.
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
