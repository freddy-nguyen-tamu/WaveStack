import { useMutation, useQuery } from "@apollo/client";
import { Archive, Database, HardDrive, RefreshCw } from "lucide-react";
import {
  ARCHIVE_OLD_LISTENING_EVENTS_MUTATION,
  LISTENING_ARCHIVE_STATUS_QUERY
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

export function ListeningArchivePanel() {
  const statusQuery = useQuery<{ listeningArchiveStatus: ArchiveStatus }>(
    LISTENING_ARCHIVE_STATUS_QUERY,
    {
      fetchPolicy: "cache-and-network"
    }
  );

  const [archiveOldEvents, archiveState] = useMutation<{
    archiveOldListeningEvents: ArchiveResult;
  }>(ARCHIVE_OLD_LISTENING_EVENTS_MUTATION);

  const status = statusQuery.data?.listeningArchiveStatus;
  const latest = archiveState.data?.archiveOldListeningEvents;

  async function runDryRun() {
    await archiveOldEvents({
      variables: {
        daysToKeep: 180,
        dryRun: true
      }
    });

    await statusQuery.refetch();
  }

  async function runArchive() {
    const confirmed = window.confirm(
      "Archive old listening events to Google Drive and delete successfully archived raw rows from Postgres?"
    );

    if (!confirmed) {
      return;
    }

    await archiveOldEvents({
      variables: {
        daysToKeep: 180,
        dryRun: false
      }
    });

    await statusQuery.refetch();
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

      <div className="archive-panel__meta">
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
      </div>

      <div className="archive-panel__actions">
        <button type="button" onClick={() => void runDryRun()} disabled={archiveState.loading}>
          Dry run archive
        </button>

        <button type="button" onClick={() => void runArchive()} disabled={archiveState.loading}>
          Archive to Drive
        </button>
      </div>

      {archiveState.loading ? <p className="archive-panel__notice">Archiving...</p> : null}

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
    </section>
  );
}
