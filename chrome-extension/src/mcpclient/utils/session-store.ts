// Persistence for streamable-HTTP Mcp-Session-Ids across service-worker restarts.
//
// MV3 service workers are killed after ~30s of inactivity, which destroys the
// in-memory MCP client pool. Storing the Mcp-Session-Id in chrome.storage.session
// lets the next connection attempt RESUME the server-side session instead of
// re-initializing (the SDK skips the initialize handshake when a transport is
// constructed with a sessionId). chrome.storage.session lives for the browser
// session and is never written to disk.

const STORAGE_PREFIX = 'mcp-session-id:';

// Memory fallback for environments without chrome.storage.session (tests, older
// Firefox) — still survives within a single worker lifetime.
const memoryStore = new Map<string, string>();

function getSessionStorage(): chrome.storage.StorageArea | null {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.session) {
      return chrome.storage.session;
    }
  } catch {
    // ignore and fall back to memory
  }
  return null;
}

export async function getSessionId(sessionKey: string): Promise<string | null> {
  const storageKey = STORAGE_PREFIX + sessionKey;
  const area = getSessionStorage();
  if (area) {
    try {
      const result = await area.get(storageKey);
      const value = result?.[storageKey];
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    } catch {
      // fall back to memory below
    }
  }
  return memoryStore.get(sessionKey) ?? null;
}

export async function saveSessionId(sessionKey: string, sessionId: string): Promise<void> {
  memoryStore.set(sessionKey, sessionId);
  const area = getSessionStorage();
  if (area) {
    try {
      await area.set({ [STORAGE_PREFIX + sessionKey]: sessionId });
    } catch {
      // memory store already updated
    }
  }
}

export async function clearSessionId(sessionKey: string): Promise<void> {
  memoryStore.delete(sessionKey);
  const area = getSessionStorage();
  if (area) {
    try {
      await area.remove(STORAGE_PREFIX + sessionKey);
    } catch {
      // ignore
    }
  }
}
