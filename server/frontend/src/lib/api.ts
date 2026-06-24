//tiny json fetch helper, throws the server's error detail on non-2xx. session cookie rides along.
export async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(detail.detail || res.statusText);
  }
  if (res.status === 204) return null as T;
  return (await res.json()) as T;
}
