from fastapi import FastAPI
from pydantic import BaseModel, Field

from app.audio_processor import analyze_audio
from app.recommender import RecommendationInput, train_recommendation_model

app = FastAPI(title="WaveStack Audio and AI Service")


class AudioProcessRequest(BaseModel):
    song_id: str = Field(min_length=1)
    blob_url: str = Field(min_length=1)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "audio-ai-service"}


@app.post("/process-audio")
def process_audio(request: AudioProcessRequest) -> dict[str, object]:
    return analyze_audio(song_id=request.song_id, blob_url=request.blob_url)


@app.post("/recommendations/train")
def train_recommendations(payload: RecommendationInput) -> dict[str, object]:
    return train_recommendation_model(payload)
