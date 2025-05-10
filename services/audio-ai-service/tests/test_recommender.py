from app.recommender import ListeningEvent, RecommendationInput, train_recommendation_model


def test_train_recommendation_model_with_events() -> None:
    payload = RecommendationInput(events=[
        ListeningEvent(
            user_id="user-1",
            song_id="song-1",
            genre_index=1,
            tempo_bpm=120,
            playlist_adds=2,
            completed_play_ratio=0.93,
        )
    ])

    result = train_recommendation_model(payload)

    assert result["trained"] is True
    assert result["eventCount"] == 1
