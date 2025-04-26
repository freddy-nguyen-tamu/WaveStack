import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { connect } from "amqplib";

export type AudioJob = {
  songId: string;
  blobUrl: string;
  requestedByUserId: string;
};

@Injectable()
export class AudioJobsProducer {
  private readonly logger = new Logger(AudioJobsProducer.name);

  constructor(private readonly config: ConfigService) {}

  async enqueueAudioProcessing(job: AudioJob): Promise<void> {
    const rabbitUrl = this.config.get<string>("RABBITMQ_URL") ?? "amqp://guest:guest@localhost:5672";
    const connection = await connect(rabbitUrl);
    const channel = await connection.createChannel();
    const exchange = "wavestack.audio";

    await channel.assertExchange(exchange, "topic", { durable: true });
    channel.publish(exchange, "audio.uploaded", Buffer.from(JSON.stringify(job)), {
      contentType: "application/json",
      persistent: true
    });

    await channel.close();
    await connection.close();
    this.logger.log(`Queued audio processing job for ${job.songId}`);
  }
}
