export type HttpFaultEffect =
  | { kind: "response"; status: number; body?: string; headers?: Record<string, string> }
  | { kind: "reject"; message: string }
  | { kind: "delay"; milliseconds: number };

export interface HttpFaultRule {
  method: string;
  pathSuffix: string;
  phase: "before" | "after";
  effect: HttpFaultEffect;
  skip?: number;
  times?: number;
}

/** Wraps a stateful HTTP fake with deterministic faults before or after its handler. */
export function createScriptedHttpFetch(handler: typeof fetch, rules: readonly HttpFaultRule[]): typeof fetch {
  const state = rules.map((rule) => ({ rule, skip: rule.skip ?? 0, remaining: rule.times ?? 1 }));
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    let fault = state.find((entry) => entry.remaining > 0 && entry.skip === 0
      && entry.rule.method === method && url.pathname.endsWith(entry.rule.pathSuffix));
    if (fault) fault.remaining -= 1;
    else {
      fault = state.find((entry) => entry.remaining > 0 && entry.skip > 0
        && entry.rule.method === method && url.pathname.endsWith(entry.rule.pathSuffix));
      if (fault) fault.skip -= 1;
    }

    if (fault?.rule.phase === "before") {
      const response = await applyFault(fault.rule.effect, init?.signal);
      if (response) return response;
    }
    const response = await handler(input, init);
    if (fault?.rule.phase === "after") {
      return (await applyFault(fault.rule.effect, init?.signal)) ?? response;
    }
    return response;
  };
}

async function applyFault(effect: HttpFaultEffect, signal?: AbortSignal | null): Promise<Response | undefined> {
  if (effect.kind === "response") {
    return new Response(effect.body ?? "", {
      status: effect.status,
      ...(effect.headers ? { headers: effect.headers } : {}),
    });
  }
  if (effect.kind === "reject") throw new Error(effect.message);
  await delayWithAbort(effect.milliseconds, signal);
  return undefined;
}

function delayWithAbort(milliseconds: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new DOMException("The scripted request was aborted.", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}
