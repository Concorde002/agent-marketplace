import type { ActorContext, DiscoveryResult, SourcingRequest, SourcingService } from "../contracts.js";
import type { ApiEvidenceCollector, CollectionOptions, DiscoveryEvidenceBundle } from "./discovery.js";

export interface AgentAssessedSourcingOptions extends CollectionOptions {
  collector: ApiEvidenceCollector;
  /** Platform-owned persistent storage, not an in-memory sourcing database. */
  persistEvidence: (bundle: DiscoveryEvidenceBundle) => Promise<void>;
}

/** Two-phase service: collect data, then wait for the authenticated client agent's assessment. */
export class AgentAssessedSourcingService implements SourcingService {
  constructor(private readonly options: AgentAssessedSourcingOptions) {}
  async discover(actor: ActorContext, request: SourcingRequest): Promise<DiscoveryResult> {
    const bundle = await this.options.collector.collect(actor, request, this.options);
    // A persistence failure must propagate; never announce an unrecorded assessment job.
    await this.options.persistEvidence(structuredClone(bundle));
    return { id: bundle.id, requestId: bundle.requestId,
      status: bundle.phase === "failed" ? "failed" : "running", candidates: [], sourceErrors: structuredClone(bundle.sourceErrors) };
  }
}
