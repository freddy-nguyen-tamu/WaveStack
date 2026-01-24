import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

type GroqMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type GroqChatOptions = {
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
};

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

@Injectable()
export class GroqTasteService {
  private readonly logger = new Logger(GroqTasteService.name);
  private nextKeyStartIndex = 0;

  constructor(private readonly config: ConfigService) {}

  configuredKeyNames(): string[] {
    return this.loadKeys().map((key) => key.name);
  }

  configuredModel(): string {
    return this.config.get<string>("GROQ_MODEL") || "llama-3.1-8b-instant";
  }

  async chat(messages: GroqMessage[], options: GroqChatOptions = {}): Promise<string> {
    const keys = this.loadKeys();
    const model = this.configuredModel();

    if (!keys.length) {
      throw new Error("No Groq API keys are configured in the graphql-api container.");
    }

    let lastError = "unknown Groq error";

    for (let round = 1; round <= 2; round += 1) {
      const orderedKeys = this.rotateKeys(keys, this.nextKeyStartIndex);

      for (const key of orderedKeys) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs ?? 45000);

        try {
          this.logger.log(`Trying Groq request with ${key.name} using model ${model}`);

          const response = await fetch(GROQ_API_URL, {
            method: "POST",
            signal: controller.signal,
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
              throw new Error("Groq returned an empty message.");
            }

            const usedIndex = keys.findIndex((item) => item.name === key.name);
            this.nextKeyStartIndex = usedIndex >= 0 ? (usedIndex + 1) % keys.length : 0;

            this.logger.log(`Groq request succeeded with ${key.name}`);
            return text;
          }

          lastError = `${key.name} HTTP ${response.status}: ${body.slice(0, 800)}`;
          this.logger.warn(lastError);

          if (response.status === 401 || response.status === 403) {
            continue;
          }

          if (response.status === 400 || response.status === 404) {
            throw new Error(lastError);
          }

          continue;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          this.logger.warn(`Groq request failed with ${key.name}: ${lastError}`);
        } finally {
          clearTimeout(timeoutId);
        }
      }

      await this.sleep(1200);
    }

    throw new Error(`All Groq API keys failed. Last error: ${lastError}`);
  }

  private loadKeys(): Array<{ name: string; value: string }> {
    const keys: Array<{ name: string; value: string }> = [];

    const base = this.config.get<string>("GROQ_API_KEY");

    if (base?.trim()) {
      keys.push({ name: "GROQ_API_KEY", value: base.trim() });
    }

    for (let index = 1; index <= 9; index += 1) {
      const name = `GROQ_API_KEY${index}`;
      const value = this.config.get<string>(name);

      if (value?.trim()) {
        keys.push({ name, value: value.trim() });
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
