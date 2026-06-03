export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/web${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  const body = await response.json().catch(() => null) as { error?: string } | T | null;
  if (!response.ok) {
    throw new Error((body && typeof body === "object" && "error" in body && body.error) || "Something went wrong.");
  }

  return body as T;
}
