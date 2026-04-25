// Chrome built-in Prompt API (Gemini Nano).
// These types are not yet in @types/chrome at the time of writing, so we
// declare a minimal subset of what we actually use.

declare global {
  interface LanguageModelCreateOptions {
    initialPrompts?: Array<{
      role: "system" | "user" | "assistant";
      content: string;
    }>;
    temperature?: number;
    topK?: number;
    monitor?: (m: EventTarget) => void;
  }

  interface LanguageModelPromptOptions {
    responseConstraint?: object;
    signal?: AbortSignal;
  }

  interface LanguageModelSession {
    prompt(input: string, options?: LanguageModelPromptOptions): Promise<string>;
    destroy(): void;
    inputUsage: number;
    inputQuota: number;
  }

  interface LanguageModelStatic {
    availability(): Promise<
      "unavailable" | "downloadable" | "downloading" | "available"
    >;
    create(options?: LanguageModelCreateOptions): Promise<LanguageModelSession>;
    params(): Promise<{
      defaultTemperature: number;
      defaultTopK: number;
      maxTopK: number;
    } | null>;
  }

  // Exposed on the global in side-panel/extension contexts.
  // eslint-disable-next-line no-var
  var LanguageModel: LanguageModelStatic | undefined;
}

export {};
