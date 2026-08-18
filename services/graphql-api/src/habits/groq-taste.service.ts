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

type GroqKey = {
  name: string;
  value: string;
};

type GroqModel = {
  id?: string;
  active?: boolean;
};

type GroqModelListResponse = {
  data?: GroqModel[];
};

type GroqModelCache = {
  expiresAt: number;
  ids: string[];
};

const GROQ_CHAT_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models";
const GROQ_MODEL_CACHE_TTL_MS = 15 * 60 * 1000;
const RETIRED_GROQ_MODELS = new Set([
  "llama-3.1-8b-instant"
]);
const FALLBACK_GROQ_CHAT_MODELS = [
  "openai/gpt-oss-20b",
  "llama-3.3-70b-versatile",
  "openai/gpt-oss-120b",
  "qwen/qwen3.6-27b",
  "groq/compound-mini",
  "groq/compound"
];
const NON_CHAT_MODEL_MARKERS = [
  "whisper",
  "tts",
  "audio",
  "guard",
  "safeguard",
  "playai",
  "orpheus"
];

@Injectable()
export class GroqTasteService {
  private readonly logger = new Logger(GroqTasteService.name);
  private nextKeyStartIndex = 0;
  private lastSuccessfulModel: string | null = null;
  private modelCache: GroqModelCache | null = null;

  constructor(private readonly config: ConfigService) {}

  configuredKeyNames(): string[] {
    return this.loadKeys().map((key) => key.name);
  }

  configuredModel(): string {
    const configured = this.configuredModelOverride();

    if (configured && this.lastSuccessfulModel && configured !== this.lastSuccessfulModel) {
      return `${configured} (last successful: ${this.lastSuccessfulModel})`;
    }

    return configured ?? this.lastSuccessfulModel ?? "auto";
  }

  async chat(messages: GroqMessage[], options: GroqChatOptions = {}): Promise<string> {
    const keys = this.loadKeys();

    if (!keys.length) {
      throw new Error("No Groq API keys are configured in the graphql-api container.");
    }

    const models = await this.modelCandidates(keys, options.timeoutMs ?? 45000);

    if (!models.length) {
      throw new Error("No usable Groq chat models were discovered.");
    }

    let lastError = "unknown Groq error";
    const disabledKeyNames = new Set<string>();
    const attemptedModels = new Set<string>();

    for (let round = 1; round <= 2; round += 1) {
      const orderedKeys = this.rotateKeys(keys, this.nextKeyStartIndex);

      for (const model of models) {
        attemptedModels.add(model);

        for (const key of orderedKeys) {
          if (disabledKeyNames.has(key.name)) {
            continue;
          }

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs ?? 45000);

          try {
            this.logger.log(`Trying Groq request with ${key.name} using model ${model}`);

            const response = await fetch(GROQ_CHAT_COMPLETIONS_URL, {
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
                max_completion_tokens: options.maxTokens ?? 900
              })
            });

            const body = await response.text();

            if (response.ok) {
              const data = JSON.parse(body) as {
                model?: string;
                choices?: Array<{ message?: { content?: string } }>;
              };

              const text = data.choices?.[0]?.message?.content?.trim();

              if (!text) {
                throw new Error("Groq returned an empty message.");
              }

              const usedIndex = keys.findIndex((item) => item.name === key.name);
              this.nextKeyStartIndex = usedIndex >= 0 ? (usedIndex + 1) % keys.length : 0;
              this.lastSuccessfulModel = data.model?.trim() || model;

              this.logger.log(`Groq request succeeded with ${key.name} using model ${this.lastSuccessfulModel}`);
              return text;
            }

            lastError = `${key.name} ${model} HTTP ${response.status}: ${this.summarizeErrorBody(body)}`;
            this.logger.warn(lastError);

            if (response.status === 401 || response.status === 403) {
              disabledKeyNames.add(key.name);
            }
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            this.logger.warn(`Groq request failed with ${key.name} using model ${model}: ${lastError}`);
          } finally {
            clearTimeout(timeoutId);
          }
        }
      }

      await this.sleep(1200);
    }

    throw new Error(
      `All Groq API keys/models failed. Tried models: ${Array.from(attemptedModels).join(", ")}. Last error: ${lastError}`
    );
  }

  private configuredModelOverride(): string | null {
    const model = this.config.get<string>("GROQ_MODEL")?.trim();

    if (!model || model.toLowerCase() === "auto" || model.toLowerCase() === "dynamic") {
      return null;
    }

    if (RETIRED_GROQ_MODELS.has(model)) {
      this.logger.warn(`Ignoring retired Groq model override: ${model}`);
      return null;
    }

    return model;
  }

  private async modelCandidates(keys: GroqKey[], timeoutMs: number): Promise<string[]> {
    const configured = this.configuredModelOverride();
    const discovered = await this.discoverModelIds(keys, Math.min(timeoutMs, 12000));

    return this.uniqueModelIds([
      this.lastSuccessfulModel,
      configured,
      ...this.sortModelIds(discovered),
      ...FALLBACK_GROQ_CHAT_MODELS
    ]);
  }

  private async discoverModelIds(keys: GroqKey[], timeoutMs: number): Promise<string[]> {
    if (this.modelCache && this.modelCache.expiresAt > Date.now()) {
      return this.modelCache.ids;
    }

    const discovered = new Set<string>();
    const orderedKeys = this.rotateKeys(keys, this.nextKeyStartIndex);
    let lastError = "unknown Groq model-list error";

    for (const key of orderedKeys) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(GROQ_MODELS_URL, {
          method: "GET",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${key.value}`,
            "content-type": "application/json"
          }
        });

        const body = await response.text();

        if (!response.ok) {
          lastError = `${key.name} HTTP ${response.status}: ${this.summarizeErrorBody(body)}`;
          this.logger.warn(`Could not list Groq models with ${lastError}`);
          continue;
        }

        const data = JSON.parse(body) as GroqModelListResponse;

        for (const model of data.data ?? []) {
          const id = model.id?.trim();

          if (id && model.active !== false && this.isLikelyChatModel(id)) {
            discovered.add(id);
          }
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Could not list Groq models with ${key.name}: ${lastError}`);
      } finally {
        clearTimeout(timeoutId);
      }
    }

    const ids = this.sortModelIds(Array.from(discovered));
    this.modelCache = {
      expiresAt: Date.now() + GROQ_MODEL_CACHE_TTL_MS,
      ids
    };

    if (!ids.length) {
      this.logger.warn(`Groq model discovery returned no chat candidates. Falling back to built-in candidates. Last error: ${lastError}`);
    }

    return ids;
  }

  private isLikelyChatModel(modelId: string): boolean {
    const lower = modelId.toLowerCase();

    if (RETIRED_GROQ_MODELS.has(modelId)) {
      return false;
    }

    return !NON_CHAT_MODEL_MARKERS.some((marker) => lower.includes(marker));
  }

  private sortModelIds(modelIds: string[]): string[] {
    return [...modelIds].sort((left, right) => (
      this.modelPreferenceRank(left) - this.modelPreferenceRank(right)
    ));
  }

  private modelPreferenceRank(modelId: string): number {
    const explicitRank = FALLBACK_GROQ_CHAT_MODELS.indexOf(modelId);

    if (explicitRank >= 0) {
      return explicitRank;
    }

    const lower = modelId.toLowerCase();

    if (lower.includes("gpt-oss-20b")) return 10;
    if (lower.includes("llama-3.3")) return 20;
    if (lower.includes("gpt-oss-120b")) return 30;
    if (lower.includes("qwen")) return 40;
    if (lower.includes("llama")) return 50;
    if (lower.includes("compound-mini")) return 60;
    if (lower.includes("compound")) return 70;

    return 100;
  }

  private uniqueModelIds(modelIds: Array<string | null | undefined>): string[] {
    const seen = new Set<string>();
    const unique: string[] = [];

    for (const modelId of modelIds) {
      const trimmed = modelId?.trim();

      if (!trimmed || seen.has(trimmed) || !this.isLikelyChatModel(trimmed)) {
        continue;
      }

      seen.add(trimmed);
      unique.push(trimmed);
    }

    return unique;
  }

  private summarizeErrorBody(body: string): string {
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string; code?: string; type?: string } };
      const parts = [
        parsed.error?.code,
        parsed.error?.type,
        parsed.error?.message
      ].filter(Boolean);

      if (parts.length) {
        return parts.join(": ");
      }
    } catch {
      // Fall through to the raw response snippet.
    }

    return body.slice(0, 800);
  }

  private loadKeys(): GroqKey[] {
    const keys: GroqKey[] = [];

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
