//the web remembers, per book, which profile you were last viewing, so reopening (and choosing one on the
//home screen) lands on the same one. the device keeps its own separate choice.
export const profKey = (bookId: string) => `cc-profile:${bookId}`;

export function loadProfile(bookId: string): string {
  try { return localStorage.getItem(profKey(bookId)) || "default"; } catch { return "default"; }
}

export function saveProfile(bookId: string, profileId: string) {
  try { localStorage.setItem(profKey(bookId), profileId); } catch { /* ignore */ }
}
