/** Bound CPU work between opportunities for timers and cancellation. */
export const CHUNK_SIZE = 16 * 1024

export class Checkpoint {
  private nextYield = performance.now() + 10

  constructor(private readonly signal?: AbortSignal) {}

  run(): Promise<void> | undefined {
    this.signal?.throwIfAborted()
    if (performance.now() < this.nextYield) return
    return this.yield()
  }

  private async yield(): Promise<void> {
    // A task-queue turn, not Promise.resolve()'s microtask continuation.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    this.nextYield = performance.now() + 10
    this.signal?.throwIfAborted()
  }
}

/** Split even a single RAM/cache blob; for-await closes producers on abort. */
export async function* chunks(
  source: Uint8Array | AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterableIterator<Uint8Array> {
  const checkpoint = new Checkpoint(signal)
  if (source instanceof Uint8Array) {
    for (let offset = 0; offset < source.byteLength; offset += CHUNK_SIZE) {
      const pending = checkpoint.run()
      if (pending !== undefined) await pending
      yield source.subarray(offset, offset + CHUNK_SIZE)
    }
    return
  }
  for await (const data of source) {
    for (let offset = 0; offset < data.byteLength; offset += CHUNK_SIZE) {
      const pending = checkpoint.run()
      if (pending !== undefined) await pending
      yield data.subarray(offset, offset + CHUNK_SIZE)
    }
  }
}
