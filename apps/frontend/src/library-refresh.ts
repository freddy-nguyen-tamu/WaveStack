import { apolloCache, apolloClient, SYNC_DRIVE_LIBRARY_MUTATION } from "./api";

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
  const result = await apolloClient.mutate({
    mutation: SYNC_DRIVE_LIBRARY_MUTATION,
    fetchPolicy: "no-cache"
  });

  const syncResult = result.data?.syncDriveLibrary;

  if (syncResult && !syncResult.ok) {
    throw new Error(syncResult.message || "Drive library sync failed.");
  }

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
