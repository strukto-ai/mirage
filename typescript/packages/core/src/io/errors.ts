/** The reader or writer of a byte pipe has closed. */
export class PipeClosed extends Error {}

/** An object a line holds grew past the line's `max_memory`. */
export class MemoryExhausted extends Error {
  constructor() {
    super('memory exhausted')
  }
}
