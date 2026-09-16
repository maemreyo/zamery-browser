import crypto from "node:crypto";

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  BROWSER_ASSET_PROVIDER_V1,
  hasCapability,
  resolveBrowserInstance,
  type BrowserAction,
  type BrowserAssetProviderV1,
  type BrowserOperationOptions,
  type BrowserProvider,
} from "@zamery/browser-provider";
import { Type } from "typebox";

import { parsePiBrowserConfig } from "./config.js";
import {
  loadBrowserProviderFactory,
  type DynamicBrowserProviderFactory,
} from "./provider-loader.js";

export const PI_BROWSER_EXTENSION_NAME = "@zamery/pi-browser";
export const PI_BROWSER_EXTENSION_VERSION = "0.1.0";
export const PI_BROWSER_EXTENSION_ID = `${PI_BROWSER_EXTENSION_NAME}@${PI_BROWSER_EXTENSION_VERSION}`;

export const BROWSER_STATUS_TOOL = "browser_status";
export const BROWSER_CONTEXTS_TOOL = "browser_contexts";
export const BROWSER_SNAPSHOT_TOOL = "browser_snapshot";
export const BROWSER_ACT_TOOL = "browser_act";
export const BROWSER_ASSETS_TOOL = "browser_assets";

export const BROWSER_ASSETS_AGENT_GUIDANCE = [
  "For save/import workflows, filter discovery results to the requested media kind and use semantic container linkage plus document order; do not infer relevance or original/full-resolution status from dimensions, filenames, or URL-like text.",
  "Treat representation.role=unknown as genuinely unknown. Do not upgrade unknown to original/preview/thumbnail without provider evidence.",
  "If multiple candidates remain equally plausible after relevant-container and newest-order evidence, ask the user rather than guessing. If an asset ref is stale or expired, rediscover instead of inventing or reconstructing a source URL.",
] as const;

export const zameryConfig = {
  revision: 1,
  unknownKeys: "reject",
  fields: {
    provider_module: { type: "module-path", required: true },
    browser_instance_id: { type: "string", nonEmpty: true },
  },
} as const;

export const zameryTools = {
  [BROWSER_STATUS_TOOL]: {
    purpose: "Read provider authorization/status and resolve one live browser instance without mutating browser state.",
    antiPurpose: "Do not use it as proof that a page is inspectable or that an action capability is ready in a specific context.",
    effect: "read-only",
    workspaceScope: "external",
    resourceScope: ["browser provider session", "live browser instance registry"],
    prerequisites: ["a configured provider module must load and expose BrowserProvider v1"],
    resultProves: "It reports the selected provider/instance status observed for this call.",
    resultDoesNotProve: "It does not prove context-level inspect/action readiness or future browser state.",
  },
  [BROWSER_CONTEXTS_TOOL]: {
    purpose: "List live browser contexts and their per-context capability availability for one selected browser instance.",
    antiPurpose: "Do not infer action readiness from provider-global capability names when a context reports unavailable.",
    effect: "read-only",
    workspaceScope: "external",
    resourceScope: ["browser provider session", "live browser tabs"],
    prerequisites: ["one browser instance must be selected explicitly, by config, or unambiguously"],
    resultProves: "It reports contexts and per-context availability observed at call time.",
    resultDoesNotProve: "It does not prove a context will remain open or unchanged after the call.",
  },
  [BROWSER_SNAPSHOT_TOOL]: {
    purpose: "Capture a semantic snapshot with opaque provider refs for one browser context.",
    antiPurpose: "Do not treat refs as stable DOM selectors or reuse them after a provider reports them stale.",
    effect: "read-only",
    workspaceScope: "external",
    resourceScope: ["browser provider session", "browser page DOM"],
    prerequisites: ["the selected context must advertise semantic snapshot readiness"],
    resultProves: "It reports the semantic nodes and provenance observed for that snapshot.",
    resultDoesNotProve: "It does not prove nodes remain connected or actionable after the snapshot.",
  },
  [BROWSER_ACT_TOOL]: {
    purpose: "Execute one typed browser action with an explicit request ID and preserve provider mutation outcome semantics.",
    antiPurpose: "Do not use it for trusted/native input, shell-like command strings, or capabilities the context does not advertise.",
    effect: "external-effect",
    workspaceScope: "external",
    resourceScope: ["browser provider session", "browser page state"],
    prerequisites: ["the context must advertise the exact typed action capability and the ref must still be valid"],
    resultProves: "It reports the provider's exact completed/not_started/partial/unknown outcome for that request ID.",
    resultDoesNotProve: "It does not imply trusted input, browser-default behavior, rollback, or safe automatic retry.",
  },
  [BROWSER_ASSETS_TOOL]: {
    purpose: "Discover browser-selected media assets in one live context and return only opaque refs plus safe semantic metadata.",
    antiPurpose: "Do not expose currentSrc/source URLs, cookies, authorization headers, storage tokens, or infer original/preview roles from dimensions or filenames.",
    effect: "read-only",
    workspaceScope: "external",
    resourceScope: ["browser provider session", "live browser DOM", "provider-owned opaque asset registry"],
    prerequisites: ["the selected provider/context must advertise BrowserAssetProviderV1 discovery readiness"],
    resultProves: "It reports the provider's safe asset descriptors observed for that context and binds each opaque asset_ref to its browser instance/context for later import.",
    resultDoesNotProve: "It does not prove an asset remains current after discovery or that an unknown representation role is an original/full-resolution resource.",
  },
} as const;

const timeoutField = Type.Optional(Type.Number({ minimum: 1, maximum: 120_000 }));
const instanceField = Type.Optional(Type.String({ minLength: 1 }));

export const browserStatusParameters = Type.Object(
  {
    browser_instance_id: instanceField,
    timeout_ms: timeoutField,
  },
  { additionalProperties: false },
);

export const browserContextsParameters = Type.Object(
  {
    browser_instance_id: instanceField,
    timeout_ms: timeoutField,
  },
  { additionalProperties: false },
);

export const browserSnapshotParameters = Type.Object(
  {
    browser_instance_id: instanceField,
    context_id: Type.String({ minLength: 1 }),
    timeout_ms: timeoutField,
  },
  { additionalProperties: false },
);

export const browserAssetsParameters = Type.Object(
  {
    browser_instance_id: instanceField,
    context_id: Type.String({ minLength: 1 }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    timeout_ms: timeoutField,
  },
  { additionalProperties: false },
);

const commonActFields = {
  request_id: Type.String({ minLength: 1, maxLength: 200 }),
  browser_instance_id: instanceField,
  context_id: Type.String({ minLength: 1 }),
  ref: Type.String({ minLength: 1 }),
  timeout_ms: timeoutField,
};

export const browserActParameters = Type.Union([
  Type.Object({ ...commonActFields, action: Type.Literal("click") }, { additionalProperties: false }),
  Type.Object({ ...commonActFields, action: Type.Literal("fill"), value: Type.String() }, { additionalProperties: false }),
  Type.Object({ ...commonActFields, action: Type.Literal("type"), text: Type.String() }, { additionalProperties: false }),
  Type.Object({ ...commonActFields, action: Type.Literal("key"), key: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
]);

interface BrowserAssetRefBinding {
  providerId: string;
  browserInstanceId: string;
  contextId: string;
  expiresAt: number;
}

interface BrowserExtensionState {
  workspaceRoot: string;
  clientId: string;
  config: ReturnType<typeof parsePiBrowserConfig>;
  factory: DynamicBrowserProviderFactory | null;
  discoveryProvider: BrowserProvider | null;
  providersByInstance: Map<string, BrowserProvider>;
  ownedProviders: Set<BrowserProvider>;
  assetRefs: Map<string, BrowserAssetRefBinding>;
}

const states = new Map<string, BrowserExtensionState>();

function operationOptions(signal: AbortSignal | undefined, timeoutMs: number | undefined): BrowserOperationOptions {
  const signals: AbortSignal[] = [];
  if (signal) signals.push(signal);
  if (timeoutMs !== undefined) signals.push(AbortSignal.timeout(timeoutMs));
  if (signals.length === 0) return {};
  return { signal: signals.length === 1 ? signals[0]! : AbortSignal.any(signals) };
}

async function createProvider(state: BrowserExtensionState, browserInstanceId?: string): Promise<BrowserProvider> {
  if (!state.factory) throw new Error("browser provider factory is not loaded");
  const provider = await state.factory({
    clientId: state.clientId,
    ...(browserInstanceId ? { browserInstanceId } : {}),
  });
  state.ownedProviders.add(provider);
  return provider;
}

async function discoveryProvider(state: BrowserExtensionState): Promise<BrowserProvider> {
  if (!state.discoveryProvider) state.discoveryProvider = await createProvider(state);
  return state.discoveryProvider;
}

async function providerForInstance(state: BrowserExtensionState, browserInstanceId: string): Promise<BrowserProvider> {
  const existing = state.providersByInstance.get(browserInstanceId);
  if (existing) return existing;
  const provider = await createProvider(state, browserInstanceId);
  state.providersByInstance.set(browserInstanceId, provider);
  return provider;
}

function asBrowserAssetProvider(provider: BrowserProvider): BrowserAssetProviderV1 {
  const candidate = provider as BrowserProvider & Partial<BrowserAssetProviderV1>;
  if (candidate.assetProtocolVersion !== BROWSER_ASSET_PROVIDER_V1
    || typeof candidate.assetCapabilities !== "function"
    || typeof candidate.discoverAssets !== "function"
    || typeof candidate.openAsset !== "function"
    || typeof candidate.readAssetChunk !== "function"
    || typeof candidate.closeAsset !== "function") {
    throw new Error("browser provider does not expose BrowserAssetProviderV1");
  }
  return candidate as BrowserProvider & BrowserAssetProviderV1;
}

function rememberAssetRefs(
  state: BrowserExtensionState,
  providerId: string,
  assets: readonly { assetRef: string; browserInstanceId: string; contextId: string; expiresAt: number }[],
): void {
  const now = Date.now();
  for (const [assetRef, binding] of state.assetRefs) {
    if (binding.expiresAt <= now) state.assetRefs.delete(assetRef);
  }
  for (const asset of assets) {
    state.assetRefs.set(asset.assetRef, {
      providerId,
      browserInstanceId: asset.browserInstanceId,
      contextId: asset.contextId,
      expiresAt: asset.expiresAt,
    });
  }
  while (state.assetRefs.size > 2_048) {
    const oldest = state.assetRefs.keys().next().value as string | undefined;
    if (!oldest) break;
    state.assetRefs.delete(oldest);
  }
}

export interface BrowserAssetProviderBridgeSelection {
  provider: BrowserAssetProviderV1;
  providerId: string;
  browserInstanceId: string;
  contextId: string;
}

/** Internal same-process bridge for the asset_import adapter. It never exposes provider URLs/credentials. */
export async function resolveBrowserAssetProviderForWorkspace(
  workspaceRoot: string,
  assetRef: string,
): Promise<BrowserAssetProviderBridgeSelection> {
  const state = states.get(workspaceRoot);
  if (!state || !state.factory) throw new Error(`browser provider state unavailable for ${workspaceRoot}`);
  const binding = state.assetRefs.get(assetRef);
  if (!binding) throw Object.assign(new Error("browser asset ref is unknown to this workspace runtime"), { code: "BROWSER_ASSET_REF_UNKNOWN" });
  if (binding.expiresAt <= Date.now()) {
    state.assetRefs.delete(assetRef);
    throw Object.assign(new Error("browser asset ref has expired"), { code: "BROWSER_ASSET_REF_EXPIRED" });
  }
  const provider = asBrowserAssetProvider(await providerForInstance(state, binding.browserInstanceId));
  return {
    provider,
    providerId: binding.providerId,
    browserInstanceId: binding.browserInstanceId,
    contextId: binding.contextId,
  };
}

async function selectInstance(
  state: BrowserExtensionState,
  requestedId: string | undefined,
  options: BrowserOperationOptions,
) {
  const discovery = await discoveryProvider(state);
  const instances = await discovery.listInstances(options);
  const selected = resolveBrowserInstance(instances, requestedId ?? state.config.browserInstanceId);
  const provider = await providerForInstance(state, selected.browserInstanceId);
  return { instances, selected, provider };
}

async function requireGlobalCapability(
  provider: BrowserProvider,
  capability: Parameters<typeof hasCapability>[1],
): Promise<void> {
  const capabilities = await provider.capabilities();
  if (!hasCapability(capabilities, capability)) {
    throw new Error(`browser provider does not advertise required capability: ${capability}`);
  }
}

async function requireContextCapability(
  provider: BrowserProvider,
  browserInstanceId: string,
  contextId: string,
  capability: "snapshot.semantic" | BrowserAction["capability"],
  options: BrowserOperationOptions,
): Promise<void> {
  const contexts = await provider.listContexts({ browserInstanceId }, options);
  const context = contexts.find((candidate) => candidate.contextId === contextId);
  if (!context) throw new Error(`browser context not found: ${contextId}`);
  if (capability === "snapshot.semantic") {
    if (context.capabilities.snapshot.state !== "ready") {
      throw new Error(`browser context snapshot unavailable: ${context.capabilities.snapshot.reason}`);
    }
    return;
  }
  const availability = context.capabilities.actions[capability];
  if (!availability || availability.state !== "ready") {
    const reason = availability && "reason" in availability ? availability.reason : "capability_not_advertised";
    throw new Error(`browser context action unavailable for ${capability}: ${reason}`);
  }
}

function actionFromParams(params: {
  action: "click" | "fill" | "type" | "key";
  ref: string;
  value?: string;
  text?: string;
  key?: string;
}): BrowserAction {
  if (params.action === "click") return { capability: "action.click.dom-synthetic", ref: params.ref };
  if (params.action === "fill") return { capability: "action.fill.dom-synthetic", ref: params.ref, value: params.value ?? "" };
  if (params.action === "type") return { capability: "action.type.text-input.dom-synthetic", ref: params.ref, text: params.text ?? "" };
  return { capability: "action.key-event.dom-synthetic", ref: params.ref, key: params.key ?? "" };
}

async function closeState(workspaceRoot: string, state: BrowserExtensionState): Promise<void> {
  const providers = [...state.ownedProviders];
  state.ownedProviders.clear();
  state.providersByInstance.clear();
  state.assetRefs.clear();
  state.discoveryProvider = null;
  const settled = await Promise.allSettled(providers.map((provider) => provider.close()));
  if (states.get(workspaceRoot) === state) states.delete(workspaceRoot);
  const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length > 0) {
    throw new AggregateError(failures.map((failure) => failure.reason), "one or more browser providers failed to close");
  }
}

export interface BrowserCreateContext {
  workspaceRoot: string;
  config: Readonly<Record<string, unknown>>;
}

type BrowserLifecycleOwner = "native-pi" | "host-resource";

function createBrowserExtension(
  context: BrowserCreateContext,
  lifecycleOwner: BrowserLifecycleOwner,
): ExtensionFactory {
  const config = parsePiBrowserConfig(context.config);
  const prior = states.get(context.workspaceRoot);
  if (prior && prior.ownedProviders.size > 0) {
    throw new Error(`browser provider state for ${context.workspaceRoot} was not disposed before replacement`);
  }

  const state: BrowserExtensionState = {
    workspaceRoot: context.workspaceRoot,
    clientId: crypto.randomUUID(),
    config,
    factory: null,
    discoveryProvider: null,
    providersByInstance: new Map(),
    ownedProviders: new Set(),
    assetRefs: new Map(),
  };
  states.set(context.workspaceRoot, state);

  return async (pi: ExtensionAPI) => {
    try {
      state.factory = await loadBrowserProviderFactory(config.providerModule);
    } catch (error) {
      if (states.get(context.workspaceRoot) === state) states.delete(context.workspaceRoot);
      throw error;
    }

    if (lifecycleOwner === "native-pi") {
      pi.on("session_shutdown", async () => {
        await closeState(context.workspaceRoot, state);
      });
    }

    pi.registerTool({
      name: BROWSER_STATUS_TOOL,
      label: "Browser status",
      description: "Read BrowserProvider status and the selected live browser instance. No page mutation is performed.",
      parameters: browserStatusParameters,
      async execute(_toolCallId, params, signal) {
        const options = operationOptions(signal, params.timeout_ms);
        const { instances, selected, provider } = await selectInstance(state, params.browser_instance_id, options);
        await requireGlobalCapability(provider, "browser.live-existing");
        const status = await provider.status(options);
        return {
          content: [{ type: "text" as const, text: `browser ${status.providerId}: ${status.authorization.state}; instance ${selected.browserInstanceId}` }],
          details: { client_id: state.clientId, selected_instance: selected, instances, status },
        };
      },
    });

    pi.registerTool({
      name: BROWSER_CONTEXTS_TOOL,
      label: "Browser contexts",
      description: "List contexts for one live browser instance with per-context snapshot/action availability.",
      parameters: browserContextsParameters,
      async execute(_toolCallId, params, signal) {
        const options = operationOptions(signal, params.timeout_ms);
        const { selected, provider } = await selectInstance(state, params.browser_instance_id, options);
        await requireGlobalCapability(provider, "context.list");
        const contexts = await provider.listContexts({ browserInstanceId: selected.browserInstanceId }, options);
        return {
          content: [{ type: "text" as const, text: `${contexts.length} browser contexts for ${selected.browserInstanceId}` }],
          details: { client_id: state.clientId, browser_instance_id: selected.browserInstanceId, contexts },
        };
      },
    });

    pi.registerTool({
      name: BROWSER_SNAPSHOT_TOOL,
      label: "Browser snapshot",
      description: "Capture a semantic snapshot and opaque refs for one browser context.",
      parameters: browserSnapshotParameters,
      async execute(_toolCallId, params, signal) {
        const options = operationOptions(signal, params.timeout_ms);
        const { selected, provider } = await selectInstance(state, params.browser_instance_id, options);
        await requireGlobalCapability(provider, "snapshot.semantic");
        await requireContextCapability(provider, selected.browserInstanceId, params.context_id, "snapshot.semantic", options);
        const snapshot = await provider.snapshot(
          { browserInstanceId: selected.browserInstanceId, contextId: params.context_id },
          options,
        );
        return {
          content: [{ type: "text" as const, text: `snapshot ${snapshot.snapshotId}: ${snapshot.nodes.length} nodes` }],
          details: { client_id: state.clientId, snapshot },
        };
      },
    });

    pi.registerTool({
      name: BROWSER_ASSETS_TOOL,
      label: "Browser assets",
      description: "Discover safe browser-backed media asset descriptors for one live context. Sensitive source URLs remain provider-internal.",
      promptSnippet: "Discover opaque browser assets and select by media kind plus semantic container/order evidence; ask rather than guess when equally plausible candidates remain.",
      promptGuidelines: [...BROWSER_ASSETS_AGENT_GUIDANCE],
      parameters: browserAssetsParameters,
      async execute(_toolCallId, params, signal) {
        const options = operationOptions(signal, params.timeout_ms);
        const { selected, provider } = await selectInstance(state, params.browser_instance_id, options);
        const assetProvider = asBrowserAssetProvider(provider);
        const capabilities = await assetProvider.assetCapabilities({
          browserInstanceId: selected.browserInstanceId,
          contextId: params.context_id,
        }, options);
        if (capabilities.discover.state !== "ready") {
          const reason = "reason" in capabilities.discover ? capabilities.discover.reason : "asset_discovery_not_ready";
          throw new Error(`browser asset discovery unavailable: ${reason}`);
        }
        const discovery = await assetProvider.discoverAssets({
          browserInstanceId: selected.browserInstanceId,
          contextId: params.context_id,
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        }, options);
        const status = await provider.status(options);
        rememberAssetRefs(state, status.providerId, discovery.assets);
        return {
          content: [{ type: "text" as const, text: `${discovery.assets.length} browser assets in ${params.context_id}` }],
          details: {
            client_id: state.clientId,
            browser_instance_id: selected.browserInstanceId,
            discovery,
          },
        };
      },
    });

    pi.registerTool({
      name: BROWSER_ACT_TOOL,
      label: "Browser act",
      description: "Execute one typed synthetic browser action and return its exact mutation outcome.",
      parameters: browserActParameters,
      async execute(_toolCallId, params, signal) {
        const options = operationOptions(signal, params.timeout_ms);
        const { selected, provider } = await selectInstance(state, params.browser_instance_id, options);
        const action = actionFromParams(params);
        await requireGlobalCapability(provider, action.capability);
        await requireContextCapability(provider, selected.browserInstanceId, params.context_id, action.capability, options);
        const result = await provider.act(
          {
            requestId: params.request_id,
            browserInstanceId: selected.browserInstanceId,
            contextId: params.context_id,
            action,
          },
          options,
        );
        return {
          content: [{ type: "text" as const, text: `${params.request_id}: ${result.outcome}` }],
          details: {
            client_id: state.clientId,
            browser_instance_id: selected.browserInstanceId,
            context_id: params.context_id,
            result,
          },
        };
      },
    });
  };
}

/**
 * Build the extension for a normal Pi host. Native Pi owns the lifecycle and the
 * extension closes every provider session from `session_shutdown`.
 */
export function createPiBrowserExtension(context: BrowserCreateContext): ExtensionFactory {
  return createBrowserExtension(context, "native-pi");
}

/**
 * Workbench adapter builder. Workbench owns teardown through `zameryResources`, so
 * this factory intentionally does not subscribe to Pi lifecycle hooks that a tools-only
 * host cannot emit.
 */
export function zameryCreateExtension(context: BrowserCreateContext): ExtensionFactory {
  return createBrowserExtension(context, "host-resource");
}

export const zameryResources = {
  declaration: "DECLARED",
  basis:
    "pi-browser may create provider session objects lazily; every created provider is tracked per workspace and closed through BrowserProvider.close() during teardown",
  allocates: ["browser-session"],
  attach: ({ workspaceRoot, runtimeInstanceId, register }: {
    workspaceRoot: string;
    runtimeInstanceId: string;
    register: (resource: unknown) => () => void;
  }) => {
    const state = states.get(workspaceRoot);
    if (!state) throw new Error(`browser provider state missing for ${workspaceRoot}`);
    register({
      id: `browser-provider-session:${runtimeInstanceId}`,
      kind: "browser-session",
      extension: PI_BROWSER_EXTENSION_ID,
      description: `provider sessions created by ${PI_BROWSER_EXTENSION_ID} for ${workspaceRoot}`,
      dispose: () => closeState(workspaceRoot, state),
    });
  },
  probe: async ({ workspaceRoot }: { workspaceRoot: string }) => {
    const state = states.get(workspaceRoot);
    if (!state || state.ownedProviders.size === 0) return [];
    return [{
      id: `browser-provider-session:${workspaceRoot}`,
      kind: "browser-session" as const,
      description: `${state.ownedProviders.size} browser provider session object(s) remain open`,
      release: () => closeState(workspaceRoot, state),
    }];
  },
} as const;

export { parsePiBrowserConfig, PiBrowserConfigError } from "./config.js";
export { loadBrowserProviderFactory } from "./provider-loader.js";
export {
  BrowserProviderV2Binding,
  createBrowserProviderV2Binding,
  loadBrowserProviderV2Factory,
  markSnapshotFreshnessUnknownAfterExternalControl,
  type BrowserProviderV2Selection,
  type DynamicBrowserProviderV2Factory,
  type DynamicBrowserProviderV2Options,
} from "./v2-binding.js";
