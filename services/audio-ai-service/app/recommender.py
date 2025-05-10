from pydantic import BaseModel
from sklearn.neighbors import NearestNeighbors
import numpy as np


class ListeningEvent(BaseModel):
    user_id: str
    song_id: str
    genre_index: int
    tempo_bpm: int
    playlist_adds: int
    completed_play_ratio: float


class RecommendationInput(BaseModel):
    events: list[ListeningEvent]


def train_recommendation_model(payload: RecommendationInput) -> dict[str, object]:
    if not payload.events:
        return {"model": "nearest-neighbors", "trained": False, "reason": "no events"}

    vectors = np.array([
        [
            event.genre_index,
            event.tempo_bpm / 200,
            event.playlist_adds,
            event.completed_play_ratio
        ]
        for event in payload.events
    ])

    model = NearestNeighbors(n_neighbors=min(3, len(payload.events)))
    model.fit(vectors)

    return {
        "model": "nearest-neighbors",
        "trained": True,
        "eventCount": len(payload.events),
        "features": ["genre", "tempo", "playlist behavior", "listening completion"]
    }
