//tiny browser helpers for download / upload of json config + context files.

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

//download an already-built blob (e.g. a server-generated zip) under a chosen filename
export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function readJsonFile<T = unknown>(file: File): Promise<T> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try { resolve(JSON.parse(String(reader.result)) as T); }
      catch { reject(new Error("not a valid JSON file")); }
    };
    reader.onerror = () => reject(reader.error || new Error("couldn't read file"));
    reader.readAsText(file);
  });
}

//a filesystem-friendly slug for export filenames
export function slug(s: string): string {
  return (s || "export").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "export";
}
