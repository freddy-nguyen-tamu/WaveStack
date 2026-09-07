// Run against the disposable regression database, after building graphql-api.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const apiRequire = require('node:module').createRequire(require.resolve('../services/graphql-api/package.json'));
const { Pool } = apiRequire('pg');
const { DriveTrackRepository } = require('../services/graphql-api/dist/src/music/drive-track.repository');
const { SONG_SEARCH_SCHEMA } = require('../services/graphql-api/dist/src/database/song-search-schema');
const pool = new Pool({ host: '127.0.0.1', port: 55439, database: 'postgres', user: 'postgres', password: 'regression' });
(async () => {
  try {
    await pool.query(fs.readFileSync(require.resolve('../infra/postgres/migrations/003_drive_tracks_performance.sql'), 'utf8'));
    await pool.query(`ALTER TABLE drive_tracks
      ADD COLUMN title_locked boolean DEFAULT false,
      ADD COLUMN drive_created_time timestamptz,
      ADD COLUMN first_seen_at timestamptz,
      ADD COLUMN owner_user_id uuid,
      ADD COLUMN source_type text DEFAULT 'drive'`);
    await pool.query(`INSERT INTO drive_tracks(id,drive_file_id,title,artist_name,normalized_search)
      VALUES ('legacy','legacy','Repaired Title','Repaired Artist','old filename')`);
    await pool.query(SONG_SEARCH_SCHEMA);
    const repo = new DriveTrackRepository(pool);
    for (const query of ['Repaired Title', 'Repaired Artist', 'old filename']) {
      assert.equal((await repo.listSongs({ first: 60, query })).nodes[0].id, 'legacy');
    }
    const song = { id: 'drive-new', fileName: 'original recording.mp3', title: 'Filename Guess', artistName: 'Filename Artist', albumTitle: 'Album', durationSeconds: 60, streamUrl: '/test', genreNames: ['Pop'] };
    await repo.upsertTracks([song]);
    await repo.updateTitleArtist(song.id, 'Actual Song Title', 'Actual Artist');
    await repo.upsertTracks([song]);
    for (const query of ['Actual Song Title', 'Actual Artist', 'original recording.mp3']) {
      assert.equal((await repo.listSongs({ first: 60, query })).nodes[0].id, song.id);
    }
    assert.equal((await repo.listSongs({ first: 60, query: 'no match anywhere' })).nodes.length, 0);
    const owner = '00000000-0000-0000-0000-000000000001';
    const [upload] = await repo.createUserSongs(owner, [{ ...song, fileName: 'upload-original.mp3' }]);
    assert.equal((await repo.listSongs({ first: 60, query: 'upload-original', userId: owner })).nodes[0].id, upload.id);
    assert.equal((await repo.listSongs({ first: 60, query: 'upload-original' })).nodes.length, 0);
    await pool.query(SONG_SEARCH_SCHEMA);
    assert.equal((await repo.getSong(song.id)).title, 'Actual Song Title');
    console.log('PASS: legacy repair, filename/title/artist, post-repair sync, empty results, upload visibility, idempotent startup');
  } finally { await pool.end(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
