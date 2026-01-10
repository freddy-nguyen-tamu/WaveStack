import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

type GroqMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type GroqChatOptions = {
  maxTokens?: number;
  temperature?: number;
};

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

@Injectable()
export class GroqTasteService {
  private readonly logger = new Logger(GroqTasteService.name);
  private nextKeyStartIndex = 0;

  constructor(private readonly config: ConfigService) {}

  async chat(messages: GroqMessage[], options: GroqChatOptions = {}): Promise<string> {
    const keys = this.loadKeys();
    const model = this.config.get<string>("GROQ_MODEL") || "llama-3.1-8b-instant";

    if (!keys.length) {
      throw new Error("No Groq API keys are configured.");
    }

    let backoffMs = 1000;
    let lastError = "unknown";

    for (let round = 1; round <= 8; round += 1) {
      const orderedKeys = this.rotateKeys(keys, this.nextKeyStartIndex);
      const waits: number[] = [];

      for (const key of orderedKeys) {
        try {
          const response = await fetch(GROQ_API_URL, {
            method: "POST",
            headers: {
              authorization: `Bearer ${key.value}`,
              "content-type": "application/json"
            },
            body: JSON.stringify({
              model,
              messages,
              temperature: options.temperature ?? 0.7,
              max_tokens: options.maxTokens ?? 900
            })
          });

          const body = await response.text();

          if (response.ok) {
            const data = JSON.parse(body) as {
              choices?: Array<{ message?: { content?: string } }>;
            };

            const text = data.choices?.[0]?.message?.content?.trim();

            if (!text) {
              throw new Error("Groq returned an empty response.");
            }

            const usedIndex = keys.findIndex((item) => item.name === key.name);
            this.nextKeyStartIndex = usedIndex >= 0 ? (usedIndex + 1) % keys.length : 0;

            return text;
          }

          if (response.status === 429 || response.status >= 500) {
            const wait = this.retryAfterMs(response.headers.get("retry-after"), backoffMs);
            waits.push(wait);
            lastError = `${key.name} ${response.status}: ${body.slice(0, 300)}`;
            this.logger.warn(`Groq temporary failure with ${key.name}: ${response.status}`);
            continue;
          }

          if (response.status === 413) {
            throw new Error(`Groq request too large: ${body.slice(0, 300)}`);
          }

          throw new Error(`Groq API error with ${key.name}: ${response.status} ${body.slice(0, 500)}`);
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          this.logger.warn(`Groq request failed with ${key.name}: ${lastError}`);
        }
      }

      if (round === 8) {
        break;
      }

      const waitMs = waits.length ? Math.max(...waits) : backoffMs;
      await this.sleep(waitMs);
      backoffMs = Math.min(Math.round(backoffMs * 1.7), 30000);
    }

    throw new Error(`All Groq API keys failed. Last error: ${lastError}`);
  }

  private loadKeys(): Array<{ name: string; value: string }> {
    const keys: Array<{ name: string; value: string }> = [];

    const base = this.config.get<string>("GROQ_API_KEY");

    if (base) {
      keys.push({ name: "GROQ_API_KEY", value: base });
    }

    for (let index = 1; index <= 9; index += 1) {
      const name = `GROQ_API_KEY${index}`;
      const value = this.config.get<string>(name);

      if (value) {
        keys.push({ name, value });
      }
    }

    return keys;
  }

  private rotateKeys<T>(items: T[], startIndex: number): T[] {
    if (!items.length) {
      return items;
    }

    const safeIndex = startIndex % items.length;
    return [...items.slice(safeIndex), ...items.slice(0, safeIndex)];
  }

  private retryAfterMs(value: string | null, fallbackMs: number): number {
    if (!value) {
      return fallbackMs;
    }

    const seconds = Number(value);

    if (Number.isFinite(seconds)) {
      return Math.max(0, seconds * 1000);
    }

    return fallbackMs;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
