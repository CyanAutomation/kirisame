import { describe, expect, it } from "vitest";
import { createScriptedHttpFetch } from "./scripted-http.js";

describe("scripted HTTP faults", () => {
  it("skips the configured matching request before applying a fault", async () => {
    let handlerCalls = 0;
    const fetch = createScriptedHttpFetch(async () => {
      handlerCalls += 1;
      return new Response("handler", { status: 200 });
    }, [{
      method: "GET",
      pathSuffix: "/branch",
      phase: "before",
      skip: 1,
      effect: { kind: "response", status: 503, body: "scripted fault" },
    }]);

    const skipped = await fetch("https://github.test/branch");
    const faulted = await fetch("https://github.test/branch");
    const recovered = await fetch("https://github.test/branch");

    expect(skipped.status).toBe(200);
    expect(faulted.status).toBe(503);
    expect(recovered.status).toBe(200);
    expect(handlerCalls).toBe(2);
  });
});
