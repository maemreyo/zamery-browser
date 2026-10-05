import type {
  BrowserControlResultV1,
  BrowserControlTargetV1,
} from "./control-v1.js";
import type { BrowserOperationOptionsV2 } from "./v2.js";

/**
 * Optional BrowserTabGroupProviderV1. A group is addressed by an opaque handle that resolves
 * internally to (trusted profile, browser run epoch, native group id, group generation); it is never a
 * naked numeric id and never matched by title.
 */
export const BROWSER_TAB_GROUP_PROVIDER_V1 = 1 as const;

export const BROWSER_TAB_GROUP_COLORS_V1 = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
] as const;

export type BrowserTabGroupColorV1 = (typeof BROWSER_TAB_GROUP_COLORS_V1)[number];
export type BrowserTabGroupHandleV1 = string;

export interface BrowserTabGroupV1 {
  handle: BrowserTabGroupHandleV1;
  /** Bumps whenever observed membership or properties change. */
  revision: number;
  windowId: number | null;
  title: string;
  color: BrowserTabGroupColorV1 | string;
  collapsed: boolean;
  /** Only authorized members are listed. */
  memberContextIds: readonly string[];
  /** True when the group has members the consumer is not authorized to see. Their count is not revealed. */
  incompleteMembership: boolean;
  policy: "membership_snapshot" | "follow_group";
}

export interface BrowserTabGroupMutationBaseV1 extends BrowserControlTargetV1 {
  requestId: string;
}

export interface BrowserTabGroupCreateRequestV1 extends BrowserTabGroupMutationBaseV1 {
  contextIds: readonly string[];
  title?: string;
  color?: BrowserTabGroupColorV1;
}

export interface BrowserTabGroupUpdateRequestV1 extends BrowserTabGroupMutationBaseV1 {
  handle: BrowserTabGroupHandleV1;
  title?: string;
  color?: BrowserTabGroupColorV1;
  collapsed?: boolean;
}

export interface BrowserTabGroupMembershipRequestV1 extends BrowserTabGroupMutationBaseV1 {
  handle: BrowserTabGroupHandleV1;
  contextIds: readonly string[];
}

export interface BrowserTabGroupMoveRequestV1 extends BrowserTabGroupMutationBaseV1 {
  handle: BrowserTabGroupHandleV1;
  index: number;
  windowId?: number;
}

export interface BrowserTabGroupActivateValueV1 {
  group: BrowserTabGroupV1;
  /** Firefox has no group-activation API: the receipt names the member that was focused. */
  focusedContextId: string;
}

export interface BrowserTabGroupProviderV1 {
  readonly tabGroupProtocolVersion: typeof BROWSER_TAB_GROUP_PROVIDER_V1;
  listTabGroups(request: BrowserControlTargetV1, options?: BrowserOperationOptionsV2): Promise<readonly BrowserTabGroupV1[]>;
  getTabGroup(
    request: BrowserControlTargetV1 & { handle: BrowserTabGroupHandleV1 },
    options?: BrowserOperationOptionsV2,
  ): Promise<BrowserTabGroupV1>;
  createTabGroup(request: BrowserTabGroupCreateRequestV1, options?: BrowserOperationOptionsV2): Promise<BrowserControlResultV1<BrowserTabGroupV1>>;
  updateTabGroup(request: BrowserTabGroupUpdateRequestV1, options?: BrowserOperationOptionsV2): Promise<BrowserControlResultV1<BrowserTabGroupV1>>;
  addTabsToGroup(request: BrowserTabGroupMembershipRequestV1, options?: BrowserOperationOptionsV2): Promise<BrowserControlResultV1<BrowserTabGroupV1>>;
  removeTabsFromGroup(request: BrowserTabGroupMembershipRequestV1, options?: BrowserOperationOptionsV2): Promise<BrowserControlResultV1<BrowserTabGroupV1 | null>>;
  moveTabGroup(request: BrowserTabGroupMoveRequestV1, options?: BrowserOperationOptionsV2): Promise<BrowserControlResultV1<BrowserTabGroupV1>>;
  activateTabGroup(
    request: BrowserTabGroupMutationBaseV1 & { handle: BrowserTabGroupHandleV1; contextId?: string },
    options?: BrowserOperationOptionsV2,
  ): Promise<BrowserControlResultV1<BrowserTabGroupActivateValueV1>>;
}

export function isBrowserTabGroupProviderV1(value: unknown): value is BrowserTabGroupProviderV1 {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BrowserTabGroupProviderV1>;
  return candidate.tabGroupProtocolVersion === BROWSER_TAB_GROUP_PROVIDER_V1
    && typeof candidate.listTabGroups === "function"
    && typeof candidate.getTabGroup === "function"
    && typeof candidate.createTabGroup === "function"
    && typeof candidate.updateTabGroup === "function"
    && typeof candidate.addTabsToGroup === "function"
    && typeof candidate.removeTabsFromGroup === "function"
    && typeof candidate.moveTabGroup === "function"
    && typeof candidate.activateTabGroup === "function";
}
