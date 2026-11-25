import { WorkerEntrypoint } from "cloudflare:workers";
import { MockGitHubAdapter } from "../../src/github/MockGitHubAdapter.js";
import { PublicationService } from "../../src/publication/service.js";
import { handlePublisherJson } from "../../src/entrypoints/publisher.js";
import type { PublicationRequest } from "../../src/contracts/types.js";

export { default } from "../../src/entrypoints/public.js";
export { PublisherEntrypoint } from "../../src/entrypoints/publisher.js";

const adapter = new MockGitHubAdapter();
const service = new PublicationService(adapter);

/** Test-only named service binding; this module is never part of the production Worker entrypoint. */
export class MockPublisherEntrypoint extends WorkerEntrypoint {
  async publish(requestJson: string) {
    return handlePublisherJson(requestJson, async (publication) => {
      await adapter.seedForRequest(publication);
      return service.publish(publication);
    });
  }

  reset(): void {
    adapter.reset();
  }

  operations(): string[] {
    return [...adapter.operations];
  }

  injectFault(operation: Parameters<MockGitHubAdapter["injectFault"]>[0], fault: Parameters<MockGitHubAdapter["injectFault"]>[1]): void {
    adapter.injectFault(operation, fault);
  }

  async moveBase(request: PublicationRequest, ref: string): Promise<string> {
    await adapter.seedForRequest(request);
    return adapter.moveBase(request.repository, ref);
  }

  async setPullRequestState(request: PublicationRequest, number: number, state: "open" | "closed" | "merged"): Promise<void> {
    await adapter.seedForRequest(request);
    adapter.setPullRequestState(request.repository, number, state);
  }
}
