import { useMutation, useQuery } from "@apollo/client";
import { Archive, Database, ExternalLink, HardDrive, RefreshCw, Thermometer } from "lucide-react";
import {
  ARCHIVE_OLD_LISTENING_EVENTS_MUTATION,
  LISTENING_ARCHIVE_STATUS_QUERY,
  LISTENING_ARCHIVE_READ_THROUGH_STATUS_QUERY,
  WARM_LISTENING_ARCHIVE_CACHE_MUTATION
} from "../../api";

type ArchiveStatus = {
  rawEventCount: number;
  archivedRollupRowCount: number;
  archiveRunCount: number;
  oldestRawEventAt?: string | null;
  latestArchiveRunAt?: string | null;
  latestArchiveStatus?: string | null;
  latestArchiveMessage?: string | null;
};

type ArchiveResult = {
  ok: boolean;
  message: string;
  exportedEventCount: number;
  deletedEventCount: number;
  driveFileCount: number;
  cutoffAt: string;
  driveFolderId?: string | null;
  runId?: string | null;
  errorMessage?: string | null;
};

type ReadThroughStatus = {
  readThroughEnabled: boolean;
  deleteAfterExport: boolean;
  rootFolderId?: string | null;
  rootFolderWebViewLink?: string | null;
  archiveFileCount: number;
  cachedArchiveFileCount: number;
  cachedEventCount: number;
  latestCachedAt?: string | null;
  latestReadAt?: string | null;
  message?: string | null;
};

type WarmResult = {
  ok: boolean;
  message: string;
  filesScanned: number;
  filesRead: number;
  eventsCached: number;
  skippedFiles: number;
  errors: string[];
};

export function ListeningArchivePanel() {
  const statusQuery = useQuery<{ listeningArchiveStatus: ArchiveStatus }>(
    LISTENING_ARCHIVE_STATUS_QUERY,
    { fetchPolicy: "cache-and-network" }
  );

  const readThroughQuery = useQuery<{ listeningArchiveReadThroughStatus: ReadThroughStatus }>(
    LISTENING_ARCHIVE_READ_THROUGH_STATUS_QUERY,
    { fetchPolicy: "cache-and-network" }
  );

  const [archiveOldEvents, archiveState] = useMutation<{
    archiveOldListeningEvents: ArchiveResult;
  }>(ARCHIVE_OLD_LISTENING_EVENTS_MUTATION);

  const [warmCache, warmState] = useMutation<{
    warmListeningArchiveCache: WarmResult;
  }>(WARM_LISTENING_ARCHIVE_CACHE_MUTATION);

  const status = statusQuery.data?.listeningArchiveStatus;
  const readThrough = readThroughQuery.data?.listeningArchiveReadThroughStatus;
  const latest = archiveState.data?.archiveOldListeningEvents;
  const warmResult = warmState.data?.warmListeningArchiveCache;

  async function runDryRun() {
    await archiveOldEvents({
      variables: { daysToKeep: 30, dryRun: true }
    });
    await statusQuery.refetch();
    await readThroughQuery.refetch();
  }

  async function runExportOnly() {
    const confirmed = window.confirm(
      "Export old listening events to Google Drive. Raw rows in Postgres will NOT be deleted (LISTENING_ARCHIVE_DELETE_AFTER_EXPORT=false)."
    );
    if (!confirmed) return;
    await archiveOldEvents({
      variables: { daysToKeep: 30, dryRun: false }
    });
    await statusQuery.refetch();
    await readThroughQuery.refetch();
  }

  async function runWarmCache() {
    await warmCache({
      variables: { period: "ALL_TIME", force: false }
    });
    await statusQuery.refetch();
    await readThroughQuery.refetch();
  }

  async function runForceRefresh() {
    await warmCache({
      variables: { period: "ALL_TIME", force: true }
    });
    await statusQuery.refetch();
    await readThroughQuery.refetch();
  }

  return (
    <section className="archive-panel" aria-label="Listening habit archive">
      <div className="archive-panel__header">
        <div>
          <p className="eyebrow">Cold storage</p>
          <h3>Listening habit archive</h3>
          <p>
            Keep recent events fast in Postgres, then archive older listening
            history into your private Google Drive folder.
          </p>
        </div>
        <Archive aria-hidden="true" />
      </div>

      <div className="archive-panel__stats">
        <div>
          <Database aria-hidden="true" />
          <strong>{status?.rawEventCount ?? "..."}</strong>
          <span>Raw Postgres events</span>
        </div>
        <div>
          <HardDrive aria-hidden="true" />
          <strong>{status?.archivedRollupRowCount ?? "..."}</strong>
          <span>Monthly rollup rows</span>
        </div>
        <div>
          <RefreshCw aria-hidden="true" />
          <strong>{status?.archiveRunCount ?? "..."}</strong>
          <span>Archive runs</span>
        </div>
      </div>

      <div className="archive-panel__subgrid">
        <div>
          <span className="archive-panel__label">Archive files</span>
          <strong className="archive-panel__value">{readThrough?.archiveFileCount ?? "..."}</strong>
        </div>
        <div>
          <span className="archive-panel__label">Cached files</span>
          <strong className="archive-panel__value">{readThrough?.cachedArchiveFileCount ?? "..."}</strong>
        </div>
        <div>
          <span className="archive-panel__label">Cached events</span>
          <strong className="archive-panel__value">{readThrough?.cachedEventCount ?? "..."}</strong>
        </div>
      </div>

      <div className="archive-panel__meta">
        <p>
          Read-through enabled:{" "}
          <strong>{readThrough?.readThroughEnabled ? "Yes" : "No"}</strong>
          {" | "}
          Delete after export:{" "}
          <strong>{readThrough?.deleteAfterExport ? "Yes" : "No"}</strong>
        </p>

        {readThrough?.rootFolderWebViewLink ? (
          <p>
            <a
              className="archive-panel__link"
              href={readThrough.rootFolderWebViewLink}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink size={14} aria-hidden="true" /> Open Listening_habits in Drive
            </a>
          </p>
        ) : null}

        <p>
          Oldest raw event:{" "}
          <strong>
            {status?.oldestRawEventAt
              ? new Date(status.oldestRawEventAt).toLocaleString()
              : "None"}
          </strong>
        </p>

        <p>
          Latest archive:{" "}
          <strong>
            {status?.latestArchiveRunAt
              ? `${new Date(status.latestArchiveRunAt).toLocaleString()} (${status.latestArchiveStatus ?? "unknown"})`
              : "Never"}
          </strong>
        </p>

        {status?.latestArchiveMessage ? <p>{status.latestArchiveMessage}</p> : null}
        {readThrough?.message ? <p>{readThrough.message}</p> : null}
      </div>

      <div className="archive-panel__description">
        <p>
          <Thermometer size={14} aria-hidden="true" />{" "}
          True cold read-through lets WaveStack restore older listening events from
          the app-created Google Drive archive into a local Postgres cache before
          stats are calculated. Keep deletion disabled until this panel shows
          successful exported files and cached events.
        </p>
      </div>

      <div className="archive-panel__actions">
        <button type="button" onClick={() => void runDryRun()} disabled={archiveState.loading}>
          Dry run archive
        </button>

        <button type="button" onClick={() => void runExportOnly()} disabled={archiveState.loading}>
          Export archive only
        </button>

        <button type="button" onClick={() => void runWarmCache()} disabled={warmState.loading}>
          Warm archive cache
        </button>

        <button type="button" onClick={() => void runForceRefresh()} disabled={warmState.loading}>
          Force refresh cache
        </button>
      </div>

      {archiveState.loading ? <p className="archive-panel__notice">Archiving...</p> : null}
      {warmState.loading ? <p className="archive-panel__notice">Warming cache...</p> : null}

      {latest ? (
        <div className={latest.ok ? "archive-panel__result archive-panel__result--ok" : "archive-panel__result archive-panel__result--error"}>
          <strong>{latest.ok ? "Archive complete" : "Archive failed"}</strong>
          <p>{latest.message}</p>
          <p>Exported events: {latest.exportedEventCount}</p>
          <p>Deleted Postgres rows: {latest.deletedEventCount}</p>
          <p>Drive files: {latest.driveFileCount}</p>
          {latest.errorMessage ? <p>{latest.errorMessage}</p> : null}
        </div>
      ) : null}

      {warmResult ? (
        <div className={warmResult.ok ? "archive-panel__result archive-panel__result--ok" : "archive-panel__result archive-panel__result--error"}>
          <strong>{warmResult.ok ? "Cache warm" : "Cache warm failed"}</strong>
          <p>{warmResult.message}</p>
          <p>Files scanned: {warmResult.filesScanned}</p>
          <p>Files read: {warmResult.filesRead}</p>
          <p>Events cached: {warmResult.eventsCached}</p>
          {warmResult.errors?.length ? <p>Errors: {warmResult.errors.join(", ")}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
