export interface PiBrowserConfig {
  providerModule: string;
  browserInstanceId?: string;
}

export class PiBrowserConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiBrowserConfigError";
  }
}

export function parsePiBrowserConfig(config: Readonly<Record<string, unknown>>): PiBrowserConfig {
  const providerModule = config.provider_module;
  if (typeof providerModule !== "string" || providerModule.trim() === "") {
    throw new PiBrowserConfigError("provider_module must be a non-empty string");
  }

  const browserInstanceId = config.browser_instance_id;
  if (browserInstanceId !== undefined && (typeof browserInstanceId !== "string" || browserInstanceId.trim() === "")) {
    throw new PiBrowserConfigError("browser_instance_id must be a non-empty string when provided");
  }

  return {
    providerModule,
    ...(typeof browserInstanceId === "string" ? { browserInstanceId } : {}),
  };
}
