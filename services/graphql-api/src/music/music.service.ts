import { Injectable } from "@nestjs/common";
import { Album, Artist, Song } from "./music.models";
import { SignedUrlService } from "../storage/signed-url.service";
import { AudioJobsProducer } from "./audio-jobs.producer";
import { GoogleDriveService } from "./google-drive.service";

@Injectable()
export class MusicService {
  constructor(
    private readonly signedUrlService: SignedUrlService,
    private readonly audioJobsProducer: AudioJobsProducer,
    private readonly googleDriveService: GoogleDriveService
  ) {}

  async listSongs(): Promise<Song[]> {
    const driveSongs = await this.googleDriveService.listSongs();

    if (driveSongs.length) {
      return driveSongs;
    }

    return [
      {
        id: "song-1",
        title: "Cloudline",
        artistName: "The Latency",
        albumTitle: "Regions",
        durationSeconds: 213,
        streamUrl: this.signedUrlService.createSignedStreamUrl("tracks/song-1/master.m3u8"),
        genreNames: ["electronic", "ambient"],
        thumbnailUrl: "https://images.unsplash.com/photo-1493246507139-91e8fad9978e?auto=format&fit=crop&w=900&q=80",
        lyrics: "Instrumental demo track."
      },
      {
        id: "song-2",
        title: "Packet Chorus",
        artistName: "Blue Queue",
        albumTitle: "Async Hearts",
        durationSeconds: 188,
        streamUrl: this.signedUrlService.createSignedStreamUrl("tracks/song-2/master.m3u8"),
        genreNames: ["indie", "pop"],
        thumbnailUrl: "https://images.unsplash.com/photo-1511379938547-c1f69419868d?auto=format&fit=crop&w=900&q=80",
        lyrics: "Demo lyrics placeholder."
      }
    ];
  }

  async listAlbums(): Promise<Album[]> {
    const songs = await this.listSongs();
    const albums = new Map<string, Album>();

    for (const song of songs) {
      const id = `${song.artistName}:${song.albumTitle}`;
      albums.set(id, {
        id,
        title: song.albumTitle,
        artistName: song.artistName
      });
    }

    return Array.from(albums.values());
  }

  async listArtists(): Promise<Artist[]> {
    const songs = await this.listSongs();
    const artists = new Map<string, Artist>();

    for (const song of songs) {
      artists.set(song.artistName, {
        id: song.artistName,
        name: song.artistName
      });
    }

    return Array.from(artists.values());
  }

  async listFavoriteSongs(): Promise<Song[]> {
    const songs = await this.listSongs();
    return songs.slice(0, 10);
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
