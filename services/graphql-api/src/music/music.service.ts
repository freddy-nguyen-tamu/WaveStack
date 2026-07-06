import { Injectable } from "@nestjs/common";
import { Album, Artist, Song, SongConnection, UserSongAttributeInput, UserSongInput } from "./music.models";
import { SignedUrlService } from "../storage/signed-url.service";
import { AudioJobsProducer } from "./audio-jobs.producer";
import { GoogleDriveService } from "./google-drive.service";
import { DriveTrackRepository } from "./drive-track.repository";

@Injectable()
export class MusicService {
  constructor(
    private readonly signedUrlService: SignedUrlService,
    private readonly audioJobsProducer: AudioJobsProducer,
    private readonly googleDriveService: GoogleDriveService,
    private readonly driveTrackRepository: DriveTrackRepository
  ) {}

  async listSongs(): Promise<Song[]> {
    const count = await this.driveTrackRepository.countTracks();

    if (count > 0) {
      const page = await this.driveTrackRepository.listSongs({ first: 80 });
      return page.nodes;
    }

    return this.googleDriveService.listSongs();
  }

  songPage(
    first: number,
    after?: string | null,
    query?: string | null,
    userId?: string | null,
    sort?: string | null
  ): Promise<SongConnection> {
    return this.driveTrackRepository.listSongs({ first, after, query, userId, sort });
  }

  randomSong(
    query?: string | null,
    userId?: string | null,
    excludeIds?: string[]
  ): Promise<Song | null> {
    return this.driveTrackRepository.getRandomSong({ query, userId, excludeIds });
  }

  async dashboardSongs(limit: number, userId?: string | null): Promise<Song[]> {
    const count = await this.driveTrackRepository.countTracks();

    if (count > 0) {
      return this.driveTrackRepository.listDashboardSongsForUser(limit, userId);
    }

    const songs = await this.googleDriveService.listSongs();
    return songs.slice(0, limit);
  }

  songDetails(id: string, userId?: string | null): Promise<Song | null> {
    return this.driveTrackRepository.getSongForUser(id, userId);
  }

  createUserSongs(userId: string, inputs: UserSongInput[]): Promise<Song[]> {
    return this.driveTrackRepository.createUserSongs(userId, inputs);
  }

  updateUserSongAttributes(userId: string, songId: string, input: UserSongAttributeInput): Promise<Song | null> {
    return this.driveTrackRepository.updateUserSongAttributes(userId, songId, input);
  }

  async listAlbums(): Promise<Album[]> {
    const songs = await this.listSongs();
    const byAlbum = new Map<string, Album>();

    for (const song of songs) {
      const id = `${song.artistName}:${song.albumTitle}`.toLowerCase();

      if (!byAlbum.has(id)) {
        byAlbum.set(id, {
          id,
          title: song.albumTitle,
          artistName: song.artistName
        });
      }
    }

    return [...byAlbum.values()];
  }

  async listArtists(): Promise<Artist[]> {
    const songs = await this.listSongs();
    const byArtist = new Map<string, Artist>();

    for (const song of songs) {
      const id = song.artistName.toLowerCase();

      if (!byArtist.has(id)) {
        byArtist.set(id, {
          id,
          name: song.artistName
        });
      }
    }

    return [...byArtist.values()];
  }

  async listFavoriteSongs(): Promise<Song[]> {
    return this.listSongs();
  }

  async requestUploadProcessing(songId: string, blobUrl: string, userId: string): Promise<boolean> {
    await this.audioJobsProducer.enqueueAudioProcessing({
      songId,
      blobUrl,
      requestedByUserId: userId
    });

    return true;
  }
}
