import { useMutation } from "@apollo/client";
import {
  EXPORT_LISTENING_HABITS_MUTATION,
  TEST_PRIVATE_DRIVE_WRITE_MUTATION
} from "../../api";

type DriveExportResult = {
  ok: boolean;
  message: string;
  folderId?: string;
  credentialsPath?: string;
  fileId?: string;
  webViewLink?: string;
};

export function DriveExportPanel() {
  const [testWrite, testResult] = useMutation<{ testPrivateDriveWrite: DriveExportResult }>(
    TEST_PRIVATE_DRIVE_WRITE_MUTATION
  );

  const [exportHabits, exportResult] = useMutation<{ exportListeningHabits: DriveExportResult }>(
    EXPORT_LISTENING_HABITS_MUTATION
  );

  const latest =
    exportResult.data?.exportListeningHabits ??
    testResult.data?.testPrivateDriveWrite ??
    null;

  return (
    <section className="drive-export-panel" aria-label="Private Drive export">
      <h3>Private Drive export</h3>
      <p>
        Test whether the API can write to your private Google Drive folder, then
        export your listening habits as JSON.
      </p>

      <div className="drive-export-panel__actions">
        <button type="button" onClick={() => void testWrite()}>
          Test private Drive write
        </button>

        <button
          type="button"
          onClick={() => void exportHabits({ variables: { period: "ALL" } })}
        >
          Export all listening habits
        </button>

        <button
          type="button"
          onClick={() => void exportHabits({ variables: { period: "WEEK" } })}
        >
          Export this week
        </button>
      </div>

      {testResult.loading || exportResult.loading ? <p>Working...</p> : null}

      {latest ? (
        <div className={latest.ok ? "drive-export-panel__result drive-export-panel__result--ok" : "drive-export-panel__result drive-export-panel__result--error"}>
          <strong>{latest.ok ? "Success" : "Failed"}</strong>
          <p>{latest.message}</p>

          {latest.folderId ? <p>Folder: {latest.folderId}</p> : null}
          {latest.credentialsPath ? <p>Credentials: {latest.credentialsPath}</p> : null}

          {latest.webViewLink ? (
            <a href={latest.webViewLink} target="_blank" rel="noreferrer">
              Open created file
            </a>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
