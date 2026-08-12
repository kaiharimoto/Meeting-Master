// One way to write text to a file the operator picks, used by every Save button.
//
// The renderer has no filesystem access (contextIsolation, no nodeIntegration),
// so saving is always two IPC hops: pickSavePath opens the OS dialog, then
// saveTextFile writes. The meeting-title -> filename slug lived inline at every
// call site and had to stay identical between them; it lives here now.
//
// Mirrors clipboard.js: the Copy path has one definition, so does the Save path.

/** Meeting title -> a filename stem that is safe on Windows. */
export function fileStem(title) {
  return (
    String(title ?? '')
      .replace(/[^\w\- ]+/g, '')
      .trim()
      .replace(/\s+/g, '-') || 'meeting'
  );
}

/**
 * Ask for a path and write `text` there.
 *
 * Returns the path written, or null when the operator cancelled the dialog or
 * the save bridge isn't available (server mode / an e2e stub). Callers report
 * their own status message, because "Transcript saved" and "AI prompt saved"
 * are different sentences.
 */
export async function saveTextAs(api, defaultName, text) {
  if (!api || typeof api.pickSavePath !== 'function' || typeof api.saveTextFile !== 'function') {
    return null;
  }
  const { filePath } = await api.pickSavePath(defaultName);
  if (!filePath) return null;
  await api.saveTextFile(filePath, text);
  return filePath;
}
