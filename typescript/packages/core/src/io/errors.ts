/** The reader or writer of a byte pipe has closed. */
export class PipeClosed extends Error {}

/** An object a command builds does not fit in its workspace's `max_memory`. */
export class MemoryExhausted extends Error {
  constructor() {
    super('memory exhausted')
  }
}
