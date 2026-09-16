import {
  BROWSER_PROVIDER_V2,
  freshnessUnknownAfterExternalControl,
  isBrowserActionReceiptV2,
  validateProviderSemanticExtensionV2,
  type BrowserActionCapabilityIdV2,
  type BrowserActionV2,
  type BrowserContextSummaryV2,
  type BrowserInstanceSummaryV2,
  type BrowserMutationResultV2,
  type BrowserOperationOptionsV2,
  type BrowserProviderDeclarationV2,
  type BrowserProviderV2,
  type BrowserSnapshotV2,
} from "@zamery/browser-provider";

export interface DynamicBrowserProviderV2Options {
  clientId: string;
  browserInstanceId?: string;
}

export type DynamicBrowserProviderV2Factory = (
  options: DynamicBrowserProviderV2Options,
) => BrowserProviderV2 | Promise<BrowserProviderV2>;

export interface BrowserProviderV2Selection {
  instance: BrowserInstanceSummaryV2;
  provider: BrowserProviderV2;
}

function assertProviderV2(value: unknown, providerModule: string): asserts value is BrowserProviderV2 {
  if (typeof value !== "object" || value === null) {
    throw new Error(`browser provider module ${providerModule} did not return a V2 object`);
  }
  const record = value as Record<string, unknown>;
  if (record.protocolVersion !== BROWSER_PROVIDER_V2) {
    throw new Error(`browser provider module ${providerModule} returned protocol ${String(record.protocolVersion)} instead of V2`);
  }
  for (const method of ["declaration", "status", "listInstances", "listContexts", "snapshot", "act", "close"] as const) {
    if (typeof record[method] !== "function") {
      throw new Error(`browser provider module ${providerModule} returned an invalid V2 provider: missing ${method}()`);
    }
  }
}

export async function loadBrowserProviderV2Factory(
  providerModule: string,
): Promise<DynamicBrowserProviderV2Factory> {
  const loaded = await import(providerModule) as Record<string, unknown>;
  const candidate = loaded.createBrowserProviderV2;
  if (typeof candidate !== "function") {
    throw new Error(`browser provider module ${providerModule} must export createBrowserProviderV2(options)`);
  }
  return async (options) => {
    const provider = await (candidate as DynamicBrowserProviderV2Factory)(options);
    assertProviderV2(provider, providerModule);
    return provider;
  };
}

function resolveInstanceV2(
  instances: readonly BrowserInstanceSummaryV2[],
  requestedId?: string,
): BrowserInstanceSummaryV2 {
  if (requestedId) {
    const selected = instances.find((instance) => instance.browserInstanceId === requestedId);
    if (!selected) throw new Error(`browser instance not found: ${requestedId}`);
    return selected;
  }
  if (instances.length === 1) return instances[0]!;
  if (instances.length === 0) throw new Error("no browser instance is available");
  throw new Error(`multiple browser instances are available: ${instances.map((item) => item.browserInstanceId).join(",")}`);
}

function validateDeclaration(declaration: BrowserProviderDeclarationV2): void {
  if (declaration.protocolVersion !== BROWSER_PROVIDER_V2) {
    throw new Error(`browser provider declaration protocol mismatch: ${declaration.protocolVersion}`);
  }
  for (const extension of declaration.providerExtensions) validateProviderSemanticExtensionV2(extension);
}

export function markSnapshotFreshnessUnknownAfterExternalControl(
  snapshot: BrowserSnapshotV2,
  observedAt: number = Date.now(),
): BrowserSnapshotV2 {
  const freshness = freshnessUnknownAfterExternalControl(snapshot.freshness, observedAt);
  return {
    ...snapshot,
    freshness,
    nodes: snapshot.nodes.map((node) => ({
      ...node,
      freshness: freshnessUnknownAfterExternalControl(node.freshness, observedAt),
    })),
  };
}

export class BrowserProviderV2Binding {
  readonly #factory: DynamicBrowserProviderV2Factory;
  readonly #clientId: string;
  #discovery: BrowserProviderV2 | null = null;
  readonly #byInstance = new Map<string, BrowserProviderV2>();
  readonly #owned = new Set<BrowserProviderV2>();

  constructor(options: { factory: DynamicBrowserProviderV2Factory; clientId: string }) {
    this.#factory = options.factory;
    this.#clientId = options.clientId;
  }

  async #create(browserInstanceId?: string): Promise<BrowserProviderV2> {
    const provider = await this.#factory({
      clientId: this.#clientId,
      ...(browserInstanceId ? { browserInstanceId } : {}),
    });
    const declaration = await provider.declaration();
    validateDeclaration(declaration);
    this.#owned.add(provider);
    return provider;
  }

  async #discoveryProvider(): Promise<BrowserProviderV2> {
    if (!this.#discovery) this.#discovery = await this.#create();
    return this.#discovery;
  }

  async #providerForInstance(browserInstanceId: string): Promise<BrowserProviderV2> {
    const existing = this.#byInstance.get(browserInstanceId);
    if (existing) return existing;
    const provider = await this.#create(browserInstanceId);
    this.#byInstance.set(browserInstanceId, provider);
    return provider;
  }

  async select(
    requestedId?: string,
    options: BrowserOperationOptionsV2 = {},
  ): Promise<BrowserProviderV2Selection> {
    const discovery = await this.#discoveryProvider();
    const instances = await discovery.listInstances(options);
    const instance = resolveInstanceV2(instances, requestedId);
    const provider = await this.#providerForInstance(instance.browserInstanceId);
    const status = await provider.status(options);
    if (status.providerSessionId !== instance.providerSessionId) {
      throw new Error(
        `provider session changed for ${instance.browserInstanceId}: ${instance.providerSessionId} -> ${status.providerSessionId}`,
      );
    }
    return { instance, provider };
  }

  async declaration(selection: BrowserProviderV2Selection): Promise<BrowserProviderDeclarationV2> {
    const declaration = await selection.provider.declaration();
    validateDeclaration(declaration);
    return declaration;
  }

  async contexts(
    selection: BrowserProviderV2Selection,
    options: BrowserOperationOptionsV2 = {},
  ): Promise<readonly BrowserContextSummaryV2[]> {
    const declaration = await this.declaration(selection);
    if (!declaration.commonCapabilities.includes("context.list")) {
      throw new Error("browser provider does not advertise required capability: context.list");
    }
    return selection.provider.listContexts({
      browserInstanceId: selection.instance.browserInstanceId,
      providerSessionId: selection.instance.providerSessionId,
    }, options);
  }

  async requireContextCapability(
    contexts: readonly BrowserContextSummaryV2[],
    contextId: string,
    capability: "snapshot.semantic" | BrowserActionCapabilityIdV2,
  ): Promise<void> {
    const context = contexts.find((candidate) => candidate.contextId === contextId);
    if (!context) throw new Error(`browser context not found: ${contextId}`);
    const availability = capability === "snapshot.semantic"
      ? context.capabilities.snapshot
      : context.capabilities.actions[capability];
    if (!availability || availability.state !== "ready") {
      const reason = availability && "reason" in availability ? availability.reason : "capability_not_advertised";
      throw new Error(`browser context capability unavailable for ${capability}: ${reason}`);
    }
  }

  async snapshot(
    selection: BrowserProviderV2Selection,
    contextId: string,
    options: BrowserOperationOptionsV2 = {},
  ): Promise<BrowserSnapshotV2> {
    const declaration = await this.declaration(selection);
    if (!declaration.commonCapabilities.includes("snapshot.semantic")) {
      throw new Error("browser provider does not advertise required capability: snapshot.semantic");
    }
    const contexts = await this.contexts(selection, options);
    await this.requireContextCapability(contexts, contextId, "snapshot.semantic");
    const snapshot = await selection.provider.snapshot({
      browserInstanceId: selection.instance.browserInstanceId,
      providerSessionId: selection.instance.providerSessionId,
      contextId,
    }, options);
    if (snapshot.providerSessionId !== selection.instance.providerSessionId) {
      throw new Error("snapshot provider session does not match selected provider session");
    }
    return snapshot;
  }

  async act(
    selection: BrowserProviderV2Selection,
    contextId: string,
    request: { requestId: string; action: BrowserActionV2 },
    options: BrowserOperationOptionsV2 = {},
  ): Promise<BrowserMutationResultV2> {
    const declaration = await this.declaration(selection);
    if (!declaration.commonCapabilities.includes(request.action.capability)) {
      throw new Error(`browser provider does not advertise required capability: ${request.action.capability}`);
    }
    const contexts = await this.contexts(selection, options);
    await this.requireContextCapability(contexts, contextId, request.action.capability);
    const result = await selection.provider.act({
      requestId: request.requestId,
      browserInstanceId: selection.instance.browserInstanceId,
      providerSessionId: selection.instance.providerSessionId,
      contextId,
      action: request.action,
    }, options);
    if (result.outcome === "completed") {
      if (!isBrowserActionReceiptV2(result.receipt)) {
        throw new Error("completed browser mutation did not return a valid BrowserActionReceiptV2");
      }
      if (
        result.receipt.requestId !== request.requestId
        || result.receipt.providerSessionId !== selection.instance.providerSessionId
        || result.receipt.action !== request.action.capability
      ) {
        throw new Error("BrowserActionReceiptV2 identity does not match the mutation request");
      }
    }
    return result;
  }

  async close(): Promise<void> {
    const providers = [...this.#owned];
    this.#owned.clear();
    this.#byInstance.clear();
    this.#discovery = null;
    const settled = await Promise.allSettled(providers.map((provider) => provider.close()));
    const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(failures.map((failure) => failure.reason), "one or more V2 browser providers failed to close");
    }
  }
}

export function createBrowserProviderV2Binding(options: {
  factory: DynamicBrowserProviderV2Factory;
  clientId: string;
}): BrowserProviderV2Binding {
  return new BrowserProviderV2Binding(options);
}
