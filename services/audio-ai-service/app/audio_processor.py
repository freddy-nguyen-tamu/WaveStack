from hashlib import sha256


def analyze_audio(song_id: str, blob_url: str) -> dict[str, object]:
    fingerprint = sha256(f"{song_id}:{blob_url}".encode("utf-8")).hexdigest()
    tempo_seed = int(fingerprint[:2], 16)

    return {
        "songId": song_id,
        "durationSeconds": 180 + tempo_seed % 120,
        "metadata": {
            "title": f"Uploaded track {song_id}",
            "artist": "Unknown artist",
            "album": "User uploads"
        },
        "waveform": generate_waveform(fingerprint),
        "tempoBpm": 80 + tempo_seed % 80,
        "genre": infer_genre(tempo_seed),
        "mood": infer_mood(tempo_seed),
        "streamableFormats": ["hls", "aac", "mp3"]
    }


def generate_waveform(fingerprint: str) -> list[float]:
    return [round(int(fingerprint[index:index + 2], 16) / 255, 3) for index in range(0, 40, 2)]


def infer_genre(seed: int) -> str:
    genres = ["electronic", "indie", "hip-hop", "ambient", "rock"]
    return genres[seed % len(genres)]


def infer_mood(seed: int) -> str:
    moods = ["focused", "bright", "late-night", "energetic", "calm"]
    return moods[seed % len(moods)]
