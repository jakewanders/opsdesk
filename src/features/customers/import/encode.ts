/** Base64 of raw bytes without building one huge string argument (a 2 MB file would overflow `String.fromCharCode(...bytes)`). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/** Why a chosen file cannot be imported, found before anything is uploaded (the server checks again and stays the authority). */
export function checkChosenFile(file: { name: string; size: number; type: string }): string | null {
  const csvName = /\.csv$/i.test(file.name);
  const csvType = /^(text\/csv|application\/csv|application\/vnd\.ms-excel)$/i.test(file.type);
  if (!csvName && !csvType) return "Choose a CSV file (a spreadsheet saved as .csv).";
  if (file.size === 0) return "That file is empty.";
  if (file.size > 2 * 1024 * 1024)
    return "That file is larger than 2 MB. Split it into smaller files.";
  return null;
}
