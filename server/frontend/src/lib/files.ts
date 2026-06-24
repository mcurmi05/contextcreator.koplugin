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

//load an image file and re-encode it as a small JPEG data: url (scaled to fit a cover thumbnail), so a
//user-uploaded custom cover stays small enough to store and sync inline. preserves aspect ratio.
export function imageFileToCoverDataUrl(file: File, maxW = 240, maxH = 360): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(maxW / img.width, maxH / img.height, 1);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) { reject(new Error("canvas not supported")); return; }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.onerror = () => reject(new Error("that file isn't a readable image"));
      img.src = String(reader.result);
    };
    reader.onerror = () => reject(reader.error || new Error("couldn't read file"));
    reader.readAsDataURL(file);
  });
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
