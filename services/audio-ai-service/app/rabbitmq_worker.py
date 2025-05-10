import json
import os

import pika

from app.audio_processor import analyze_audio


def run_worker() -> None:
    rabbitmq_url = os.getenv("RABBITMQ_URL", "amqp://guest:guest@localhost:5672")
    connection = pika.BlockingConnection(pika.URLParameters(rabbitmq_url))
    channel = connection.channel()
    channel.exchange_declare(exchange="wavestack.audio", exchange_type="topic", durable=True)
    channel.queue_declare(queue="audio-processing", durable=True)
    channel.queue_bind(queue="audio-processing", exchange="wavestack.audio", routing_key="audio.uploaded")

    def handle_message(ch, method, properties, body) -> None:
        payload = json.loads(body)
        result = analyze_audio(song_id=payload["songId"], blob_url=payload["blobUrl"])
        ch.basic_publish(
            exchange="wavestack.audio",
            routing_key="audio.processed",
            body=json.dumps(result).encode("utf-8"),
            properties=pika.BasicProperties(content_type="application/json", delivery_mode=2),
        )
        ch.basic_ack(delivery_tag=method.delivery_tag)

    channel.basic_consume(queue="audio-processing", on_message_callback=handle_message)
    channel.start_consuming()


if __name__ == "__main__":
    run_worker()
