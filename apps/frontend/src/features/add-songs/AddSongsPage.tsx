import { useMemo, useState } from "react";
import { useMutation } from "@apollo/client";
import { Check, ListPlus, Music2, Pencil, Upload } from "lucide-react";
import {
  CREATE_USER_SONGS_MUTATION,
  UPDATE_USER_SONG_ATTRIBUTES_MUTATION
} from "../../api";
import type { Song } from "../../App";
import { SongArtwork } from "../../components/SongArtwork";
import { UploadButton } from "../../components/UploadButton";
import { formatSongDisplayName } from "../../song-format";

type AddSongsPageProps = {
  isSignedIn: boolean;
  onSongsAdded: (songs: Song[]) => void;
  onNotice: (message: string) => void;
  onUploadFiles: (files: File[]) => void;
};

type DraftSong = {
  id: string;
  title: string;
  artistName: string;
  albumTitle: string;
  durationSeconds: string;
  streamUrl: string;
  genreNames: string;
  thumbnailUrl: string;
  lyrics: string;
  editable: Record<EditableField, boolean>;
};

type EditableField =
  | "title"
  | "artistName"
  | "albumTitle"
  | "durationSeconds"
  | "streamUrl"
  | "genreNames"
  | "thumbnailUrl"
  | "lyrics";

type UserSongInput = {
  title: string;
  artistName: string;
  albumTitle?: string;
  durationSeconds?: number;
  streamUrl?: string;
  genreNames?: string[];
  thumbnailUrl?: string;
  lyrics?: string;
};

type CreateUserSongsData = {
  createUserSongs: Song[];
};

type UpdateUserSongAttributesData = {
  updateUserSongAttributes: Song | null;
};

const editableFields: Array<{ key: EditableField; label: string; multiline?: boolean }> = [
  { key: "title", label: "Title" },
  { key: "artistName", label: "Artist" },
  { key: "albumTitle", label: "Album" },
  { key: "durationSeconds", label: "Duration" },
  { key: "streamUrl", label: "Stream URL" },
  { key: "genreNames", label: "Genres" },
  { key: "thumbnailUrl", label: "Thumbnail URL" },
  { key: "lyrics", label: "Lyrics", multiline: true }
];

function blankEditable(selected = false): Record<EditableField, boolean> {
  return {
    title: selected,
    artistName: selected,
    albumTitle: selected,
    durationSeconds: selected,
    streamUrl: selected,
    genreNames: selected,
    thumbnailUrl: selected,
    lyrics: selected
  };
}

function newDraft(values: Partial<DraftSong> = {}): DraftSong {
  return {
    id: crypto.randomUUID(),
    title: values.title ?? "",
    artistName: values.artistName ?? "",
    albumTitle: values.albumTitle ?? "",
    durationSeconds: values.durationSeconds ?? "",
    streamUrl: values.streamUrl ?? "",
    genreNames: values.genreNames ?? "",
    thumbnailUrl: values.thumbnailUrl ?? "",
    lyrics: values.lyrics ?? "",
    editable: values.editable ?? blankEditable(true)
  };
}

function draftFromSong(song: Song): DraftSong {
  return newDraft({
    title: song.title,
    artistName: song.artistName,
    albumTitle: song.albumTitle,
    durationSeconds: song.durationSeconds ? String(song.durationSeconds) : "",
    streamUrl: song.streamUrl,
    genreNames: song.genreNames.join(", "),
    thumbnailUrl: song.thumbnailUrl ?? song.localThumbnailUrl ?? song.driveThumbnailUrl ?? "",
    lyrics: song.lyrics ?? "",
    editable: blankEditable()
  });
}

function draftToInput(draft: DraftSong): UserSongInput {
  return {
    title: draft.title.trim() || "Untitled song",
    artistName: draft.artistName.trim() || "Unknown Artist",
    albumTitle: draft.albumTitle.trim() || "User additions",
    durationSeconds: Number(draft.durationSeconds) || 0,
    streamUrl: draft.streamUrl.trim() || undefined,
    genreNames: splitGenres(draft.genreNames),
    thumbnailUrl: draft.thumbnailUrl.trim() || undefined,
    lyrics: draft.lyrics.trim() || undefined
  };
}

function splitGenres(value: string): string[] {
  return value
    .split(",")
    .map((genre) => genre.trim())
    .filter(Boolean);
}

function parseBulkRows(value: string): DraftSong[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [title, artistName, streamUrl, albumTitle, genreNames, durationSeconds, thumbnailUrl, lyrics] = line
        .split("|")
        .map((item) => item.trim());

      return newDraft({
        title: title ?? "",
        artistName: artistName ?? "",
        streamUrl: streamUrl ?? "",
        albumTitle: albumTitle ?? "",
        genreNames: genreNames ?? "",
        durationSeconds: durationSeconds ?? "",
        thumbnailUrl: thumbnailUrl ?? "",
        lyrics: lyrics ?? ""
      });
    });
}

export function AddSongsPage({ isSignedIn, onSongsAdded, onNotice, onUploadFiles }: AddSongsPageProps) {
  const [mode, setMode] = useState<"single" | "bulk" | "local">("single");
  const [reviewBeforeSave, setReviewBeforeSave] = useState(true);
  const [drafts, setDrafts] = useState<DraftSong[]>(() => [newDraft()]);
  const [bulkText, setBulkText] = useState("");
  const [savedSongs, setSavedSongs] = useState<Song[]>([]);
  const [savedEdits, setSavedEdits] = useState<Record<string, DraftSong>>({});

  const [createUserSongs, createState] = useMutation<CreateUserSongsData>(CREATE_USER_SONGS_MUTATION);
  const [updateUserSongAttributes, updateState] = useMutation<UpdateUserSongAttributesData>(UPDATE_USER_SONG_ATTRIBUTES_MUTATION);

  const validDrafts = useMemo(
    () => drafts.filter((draft) => draft.title.trim() || draft.artistName.trim() || draft.streamUrl.trim()),
    [drafts]
  );

  function updateDraft(id: string, field: EditableField, value: string) {
    setDrafts((current) => current.map((draft) => draft.id === id ? { ...draft, [field]: value } : draft));
  }

  function toggleDraftField(id: string, field: EditableField) {
    setDrafts((current) => current.map((draft) => (
      draft.id === id
        ? { ...draft, editable: { ...draft.editable, [field]: !draft.editable[field] } }
        : draft
    )));
  }

  function updateSavedDraft(songId: string, field: EditableField, value: string) {
    setSavedEdits((current) => ({
      ...current,
      [songId]: {
        ...(current[songId] ?? draftFromSong(savedSongs.find((song) => song.id === songId)!)),
        [field]: value
      }
    }));
  }

  function toggleSavedField(songId: string, field: EditableField) {
    setSavedEdits((current) => {
      const draft = current[songId] ?? draftFromSong(savedSongs.find((song) => song.id === songId)!);
      return {
        ...current,
        [songId]: {
          ...draft,
          editable: { ...draft.editable, [field]: !draft.editable[field] }
        }
      };
    });
  }

  function applyBulkText() {
    const parsed = parseBulkRows(bulkText);
    setDrafts(parsed.length ? parsed : [newDraft()]);
    setMode("bulk");
    setReviewBeforeSave(true);
    onNotice(parsed.length ? `Prepared ${parsed.length} song draft(s).` : "Paste at least one song row.");
  }

  async function saveDrafts() {
    if (!isSignedIn) {
      onNotice("Sign in before adding private songs.");
      return;
    }

    if (!validDrafts.length) {
      onNotice("Add at least one song title, artist, or stream URL first.");
      return;
    }

    const result = await createUserSongs({
      variables: {
        inputs: validDrafts.map(draftToInput)
      },
      fetchPolicy: "no-cache"
    });

    const created = result.data?.createUserSongs ?? [];

    if (!created.length) {
      onNotice("No songs were added.");
      return;
    }

    setSavedSongs(created);
    setSavedEdits(Object.fromEntries(created.map((song) => [song.id, draftFromSong(song)])));
    setDrafts([newDraft()]);
    setBulkText("");
    onSongsAdded(created);
    onNotice(`Added ${created.length} private song(s).`);
  }

  async function saveSelectedAttributes(song: Song) {
    const draft = savedEdits[song.id] ?? draftFromSong(song);
    const input = selectedAttributePatch(draft);

    if (!Object.keys(input).length) {
      onNotice("Choose at least one attribute to update.");
      return;
    }

    const result = await updateUserSongAttributes({
      variables: {
        songId: song.id,
        input
      },
      fetchPolicy: "no-cache"
    });

    const updated = result.data?.updateUserSongAttributes;

    if (!updated) {
      onNotice("Could not update that private song.");
      return;
    }

    setSavedSongs((current) => current.map((item) => item.id === updated.id ? updated : item));
    setSavedEdits((current) => ({ ...current, [updated.id]: draftFromSong(updated) }));
    onSongsAdded([updated]);
    onNotice(`Updated ${formatSongDisplayName(updated)}.`);
  }

  function selectedAttributePatch(draft: DraftSong): Partial<UserSongInput> {
    const patch: Partial<UserSongInput> = {};

    if (draft.editable.title) patch.title = draft.title;
    if (draft.editable.artistName) patch.artistName = draft.artistName;
    if (draft.editable.albumTitle) patch.albumTitle = draft.albumTitle;
    if (draft.editable.durationSeconds) patch.durationSeconds = Number(draft.durationSeconds) || 0;
    if (draft.editable.streamUrl) patch.streamUrl = draft.streamUrl;
    if (draft.editable.genreNames) patch.genreNames = splitGenres(draft.genreNames);
    if (draft.editable.thumbnailUrl) patch.thumbnailUrl = draft.thumbnailUrl;
    if (draft.editable.lyrics) patch.lyrics = draft.lyrics;

    return patch;
  }

  return (
    <article className="add-songs-page">
      <p className="eyebrow">Private library</p>
      <h2>Add Songs</h2>
      <p>
        Add one track or paste many at once. Songs you save here are private to your account,
        then appear in your search results, recommendations, playlists, favorites, and queue.
      </p>

      {!isSignedIn ? (
        <p role="alert">Sign in before saving private songs.</p>
      ) : null}

      <div className="add-songs-page__mode-row" role="tablist" aria-label="Add song mode">
        <button type="button" aria-pressed={mode === "single"} onClick={() => setMode("single")}>
          <Music2 aria-hidden="true" /> Single song
        </button>
        <button type="button" aria-pressed={mode === "bulk"} onClick={() => setMode("bulk")}>
          <ListPlus aria-hidden="true" /> Bulk add
        </button>
        <button type="button" aria-pressed={mode === "local"} onClick={() => setMode("local")}>
          <Upload aria-hidden="true" /> Local files
        </button>
      </div>

      <label className="add-songs-page__review-toggle">
        <input
          type="checkbox"
          checked={reviewBeforeSave}
          onChange={(event) => setReviewBeforeSave(event.target.checked)}
        />
        Review selected attributes before saving
      </label>

      {mode === "bulk" ? (
        <section>
          <h3>Bulk input</h3>
          <p>
            One song per line: title | artist | stream URL | album | genres | duration seconds | thumbnail URL | lyrics
          </p>
          <textarea
            value={bulkText}
            onChange={(event) => setBulkText(event.target.value)}
            rows={8}
            placeholder="Cloudline | The Latency | https://example.com/cloudline.mp3 | Regions | ambient, electronic | 213 | https://example.com/cover.jpg | Instrumental demo"
          />
          <button type="button" onClick={applyBulkText}>
            <Upload aria-hidden="true" /> Prepare bulk songs
          </button>
        </section>
      ) : null}

      {mode === "local" ? (
        <section className="add-songs-page__local-upload" aria-label="Upload local audio files">
          <h3>Upload local audio</h3>
          <p>
            Choose one audio file or select multiple audio files at once. This opens your local PC file picker and uploads the files to your private library.
          </p>
          <UploadButton
            label="Choose local audio files"
            multiple
            className="add-songs-page__upload-button"
            onUploadFiles={onUploadFiles}
          />
          <p className="add-songs-page__upload-help">
            Supported by the browser file picker: MP3, M4A, WAV, FLAC, AAC, OGG, OPUS, WEBM audio, and other audio/* files.
          </p>
        </section>
      ) : null}

      <section>
        <h3>{reviewBeforeSave ? "Review drafts" : "Song details"}</h3>
        <div className="add-songs-page__drafts">
          {drafts.map((draft, index) => (
            <div className="add-song-card" key={draft.id}>
              <div className="add-song-card__header">
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{draft.title || "Untitled song"}</strong>
              </div>

              <div className="add-song-card__fields">
                {editableFields.map((field) => (
                  <label key={field.key}>
                    {reviewBeforeSave ? (
                      <span className="add-song-card__field-toggle">
                        <input
                          type="checkbox"
                          checked={draft.editable[field.key]}
                          onChange={() => toggleDraftField(draft.id, field.key)}
                        />
                        Edit {field.label}
                      </span>
                    ) : field.label}
                    {field.multiline ? (
                      <textarea
                        value={draft[field.key]}
                        disabled={reviewBeforeSave && !draft.editable[field.key]}
                        rows={5}
                        onChange={(event) => updateDraft(draft.id, field.key, event.target.value)}
                      />
                    ) : (
                      <input
                        value={draft[field.key]}
                        disabled={reviewBeforeSave && !draft.editable[field.key]}
                        onChange={(event) => updateDraft(draft.id, field.key, event.target.value)}
                      />
                    )}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="add-songs-page__actions">
          <button type="button" onClick={() => setDrafts((current) => [...current, newDraft()])}>
            <ListPlus aria-hidden="true" /> Add another draft
          </button>
          <button type="button" onClick={() => void saveDrafts()} disabled={createState.loading || !validDrafts.length}>
            <Check aria-hidden="true" /> Save private song{validDrafts.length === 1 ? "" : "s"}
          </button>
        </div>
      </section>

      {savedSongs.length ? (
        <section>
          <h3>Edit saved songs</h3>
          <ul className="add-songs-page__saved-list">
            {savedSongs.map((song) => {
              const draft = savedEdits[song.id] ?? draftFromSong(song);

              return (
                <li key={song.id} className="song-list-row add-songs-page__saved-song">
                  <SongArtwork
                    song={song}
                    wrapClassName="song-list-row__art"
                    fallbackClassName="song-list-row__art-fallback"
                    imageClassName="song-list-row__art-image"
                  />
                  <div className="song-list-row__body">
                    <strong>{formatSongDisplayName(song)}</strong>
                    <small>{song.albumTitle}</small>

                    <details>
                      <summary><Pencil aria-hidden="true" /> Choose attributes to edit</summary>
                      <div className="add-song-card__fields">
                        {editableFields.map((field) => (
                          <label key={field.key}>
                            <span className="add-song-card__field-toggle">
                              <input
                                type="checkbox"
                                checked={draft.editable[field.key]}
                                onChange={() => toggleSavedField(song.id, field.key)}
                              />
                              Edit {field.label}
                            </span>
                            {field.multiline ? (
                              <textarea
                                value={draft[field.key]}
                                disabled={!draft.editable[field.key]}
                                rows={5}
                                onChange={(event) => updateSavedDraft(song.id, field.key, event.target.value)}
                              />
                            ) : (
                              <input
                                value={draft[field.key]}
                                disabled={!draft.editable[field.key]}
                                onChange={(event) => updateSavedDraft(song.id, field.key, event.target.value)}
                              />
                            )}
                          </label>
                        ))}
                      </div>
                      <button type="button" onClick={() => void saveSelectedAttributes(song)} disabled={updateState.loading}>
                        <Check aria-hidden="true" /> Save selected attributes
                      </button>
                    </details>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </article>
  );
}
