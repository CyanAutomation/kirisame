import { describe, expect, it } from "vitest";
import { readLimitedBytes } from "../../src/shared/streams.js";

function stream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("readLimitedBytes", () => {
  it("joins streamed chunks up to the exact byte limit", async () => {
    const result = await readLimitedBytes(stream([new Uint8Array([65]), new Uint8Array([66, 67])]), 3);

    expect(result).toEqual(new Uint8Array([65, 66, 67]));
  });

  it("returns undefined when streamed content exceeds the byte limit", async () => {
    const result = await readLimitedBytes(stream([new Uint8Array([65, 66]), new Uint8Array([67, 68])]), 3);

    expect(result).toBeUndefined();
  });

  it("returns an empty byte array for an empty stream", async () => {
    const result = await readLimitedBytes(stream([]), 3);

    expect(result).toEqual(new Uint8Array());
  });
});
