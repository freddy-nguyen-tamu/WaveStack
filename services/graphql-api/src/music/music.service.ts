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
        genreNames: ["electronic", "ambient"]
      },
      {
        id: "song-2",
        title: "Packet Chorus",
        artistName: "Blue Queue",
        albumTitle: "Async Hearts",
        durationSeconds: 188,
        streamUrl: this.signedUrlService.createSignedStreamUrl("tracks/song-2/master.m3u8"),
        genreNames: ["indie", "pop"]
      }
    ];
  }

  async listAlbums(): Promise<Album[]> {
    return [
      { id: "album-1", title: "Regions", artistName: "The Latency" },
      { id: "album-2", title: "Async Hearts", artistName: "Blue Queue" }
    ];
  }

  async listArtists(): Promise<Artist[]> {
    return [
      { id: "artist-1", name: "The Latency" },
      { id: "artist-2", name: "Blue Queue" }
    ];
  }

  async listFavoriteSongs(): Promise<Song[]> {
    const songs = await this.listSongs();
    return songs.slice(0, 1);
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
