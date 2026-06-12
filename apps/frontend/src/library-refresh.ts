import { apolloCache, apolloClient } from "./api";

function removeLocalStorageKey(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch (error) {
    console.warn(`Could not remove ${key}`, error);
  }
}

function deleteIndexedDbDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    if (!("indexedDB" in window)) {
      resolve();
      return;
    }

    try {
      const request = window.indexedDB.deleteDatabase(name);

      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch (error) {
      console.warn(`Could not delete IndexedDB database ${name}`, error);
      resolve();
    }
  });
}

export async function refreshWaveStackLibraryCache(): Promise<void> {
  removeLocalStorageKey("wavestack:song-cache");
  removeLocalStorageKey("wavestack:apollo-cache");
  removeLocalStorageKey("apollo-cache-persist");

  try {
    await apolloClient.clearStore();
  } catch (error) {
    console.warn("Could not clear Apollo store", error);
  }

  try {
    apolloCache.gc();
  } catch (error) {
    console.warn("Could not garbage collect Apollo cache", error);
  }

  await deleteIndexedDbDatabase("apollo-cache-persist");

  window.location.reload();
}
