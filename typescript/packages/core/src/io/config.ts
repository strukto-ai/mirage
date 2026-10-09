import { z } from 'zod'
import { CHUNK_SIZE } from './cooperative.ts'
import { CAPACITY } from './pipe.ts'

/** Workspace limits for each in-flight byte queue. */
export class IOConfig {
  readonly bufferBytes: number

  constructor(config: { readonly bufferBytes?: number } = {}) {
    const parsed = z
      .object({
        bufferBytes: z
          .number()
          .int()
          .min(CHUNK_SIZE)
          .max(Number.MAX_SAFE_INTEGER)
          .default(CAPACITY),
      })
      .strict()
      .parse(config)
    this.bufferBytes = parsed.bufferBytes
    Object.freeze(this)
  }
}
