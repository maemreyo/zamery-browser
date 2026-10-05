export interface StoredObservation {
  observationId: string;
  contextId: string;
  browserInstanceId: string;
  providerSessionId: string;
  /** Short model-facing ref (`e1`) -> provider ref. Provider refs are long opaque strings. */
  refs: ReadonlyMap<string, string>;
  createdAt: number;
}

/**
 * Remembers recent observations so tools can take short refs. Observations are evidence of a past
 * page state, never authority: the provider and companion re-validate everything at action time.
 */
export class ObservationStore {
  readonly #byId = new Map<string, StoredObservation>();
  readonly #max: number;

  constructor(max = 32) {
    this.#max = max;
  }

  put(observation: StoredObservation): void {
    this.#byId.delete(observation.observationId);
    this.#byId.set(observation.observationId, observation);
    while (this.#byId.size > this.#max) {
      const oldest = this.#byId.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#byId.delete(oldest);
    }
  }

  get(observationId: string): StoredObservation | undefined {
    return this.#byId.get(observationId);
  }

  /** Newer observations of a context supersede older ones: dropping them avoids acting on a stale view. */
  supersede(contextId: string, keep: string): void {
    for (const [id, observation] of this.#byId) {
      if (observation.contextId === contextId && id !== keep) this.#byId.delete(id);
    }
  }

  clear(): void {
    this.#byId.clear();
  }
}
