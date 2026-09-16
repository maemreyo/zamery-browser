import type { BrowserProvider } from "@zamery/browser-provider";

export interface DynamicBrowserProviderOptions {
  clientId: string;
  browserInstanceId?: string;
}

export type DynamicBrowserProviderFactory = (
  options: DynamicBrowserProviderOptions,
) => BrowserProvider | Promise<BrowserProvider>;

function assertProvider(value: unknown, providerModule: string): asserts value is BrowserProvider {
  if (typeof value !== "object" || value === null) {
    throw new Error(`browser provider module ${providerModule} did not return an object`);
  }
  const record = value as Record<string, unknown>;
  for (const method of ["capabilities", "status", "listInstances", "listContexts", "snapshot", "act", "close"] as const) {
    if (typeof record[method] !== "function") {
      throw new Error(`browser provider module ${providerModule} returned an invalid provider: missing ${method}()`);
    }
  }
}

export async function loadBrowserProviderFactory(providerModule: string): Promise<DynamicBrowserProviderFactory> {
  const loaded = await import(providerModule) as Record<string, unknown>;
  const candidate = loaded.createBrowserProvider;
  if (typeof candidate !== "function") {
    throw new Error(`browser provider module ${providerModule} must export createBrowserProvider(options)`);
  }

  return async (options) => {
    const provider = await (candidate as DynamicBrowserProviderFactory)(options);
    assertProvider(provider, providerModule);
    return provider;
  };
}
