from app.audio_processor import analyze_audio


def test_analyze_audio_returns_metadata_and_waveform() -> None:
    result = analyze_audio("song-1", "https://storage.example/song-1.wav")

    assert result["songId"] == "song-1"
    assert result["durationSeconds"] > 0
    assert result["metadata"]["artist"] == "Unknown artist"
    assert len(result["waveform"]) == 20
    assert "hls" in result["streamableFormats"]
