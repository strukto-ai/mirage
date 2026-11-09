import { makeAbortError } from '../utils/abort.ts'
import { concat } from '../utils/bytes.ts'
import { CHUNK_SIZE } from './cooperative.ts'
import { PipeClosed } from './errors.ts'

export const CAPACITY = 4 * CHUNK_SIZE

/**
 * Buffers their producer never writes again, such as mirage-rs output copied
 * out of linear memory. A pipe keeps a chunk of one up to twice its capacity
 * as written, so a reader holding a few bytes never pins a much larger
 * buffer; it copies a chunk of any other buffer, in case the writer reuses it.
 */
export const SEALED = new WeakSet<ArrayBufferLike>()

const POLL_MS = 10

/** One reader and bounded asynchronous writes. Closing either endpoint wakes writers. */
export class BytePipe {
  /**
   * @param capacity The most bytes held before a write waits.
   * @param polled The two ends sit in different requests on an edge runtime,
   * where a wake from one request would run the waiter inside it, so a waiter
   * looks for a change on its own timer instead.
   */
  constructor(
    private readonly capacity = CAPACITY,
    private readonly polled = false,
    private readonly gate: (() => Promise<void> | null) | null = null,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < CHUNK_SIZE)
      throw new Error('pipe capacity must be an integer from 16384 to 9007199254740991')
  }
  private chunks: Uint8Array[] = []
  private bytes = 0
  private ended = false
  private readerClosed = false
  private reading = false
  private waiting = false
  private delivered = 0
  private accepted = 0
  private failure: Error | undefined
  private wake: (() => void)[] = []

  get bufferedBytes(): number {
    return this.bytes
  }

  get closedReader(): boolean {
    return this.readerClosed
  }

  private notify(): void {
    for (const resolve of this.wake.splice(0)) resolve()
  }

  private changed(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const changed = (): void => {
        signal?.removeEventListener('abort', aborted)
        resolve()
      }
      const aborted = (): void => {
        clearTimeout(timer)
        this.wake = this.wake.filter((wake) => wake !== changed)
        signal?.removeEventListener('abort', aborted)
        reject(makeAbortError(signal))
      }
      if (this.polled) timer = setTimeout(changed, POLL_MS)
      else this.wake.push(changed)
      signal?.addEventListener('abort', aborted, { once: true })
    })
  }

  /** Accept bytes in bounded chunks, waiting for available capacity. */
  async write(data: Uint8Array, signal?: AbortSignal): Promise<void> {
    const held = this.gate?.() ?? null
    if (held !== null) await held
    for (let start = 0; start < data.byteLength; start += CHUNK_SIZE) {
      signal?.throwIfAborted()
      const length = Math.min(CHUNK_SIZE, data.byteLength - start)
      while (this.bytes + length > this.capacity && !this.readerClosed && !this.ended)
        await this.changed(signal)
      if (signal?.aborted === true) throw makeAbortError(signal)
      if (this.readerClosed || this.ended) throw new PipeClosed()
      const piece = data.subarray(start, start + length)
      const lent = SEALED.has(data.buffer) && data.buffer.byteLength <= 2 * this.capacity
      const chunk = lent ? piece : new Uint8Array(piece)
      this.chunks.push(chunk)
      this.bytes += length
      this.delivered += 1
      this.notify()
    }
  }

  private merged(taken: Uint8Array[]): Uint8Array {
    const [first, ...rest] = taken
    if (first === undefined) return new Uint8Array()
    if (rest.length === 0) return first
    let end = first.byteOffset + first.byteLength
    for (const chunk of rest) {
      if (chunk.buffer !== first.buffer || chunk.byteOffset !== end) return concat(taken)
      end += chunk.byteLength
    }
    return new Uint8Array(first.buffer, first.byteOffset, end - first.byteOffset)
  }

  /** Wait until the reader consumes accepted writes or closes. */
  async drain(): Promise<void> {
    while (this.accepted < this.delivered && !this.readerClosed) await this.changed()
  }

  /** Close the writer, preserving buffered bytes and a late failure. */
  end(error?: unknown): void {
    if (this.ended) return
    if (error !== undefined)
      this.failure =
        error instanceof Error ? error : new Error('Pipeline producer failed', { cause: error })
    this.ended = true
    this.notify()
  }

  closeReader(): void {
    this.readerClosed = true
    this.chunks = []
    this.bytes = 0
    this.notify()
  }

  /** Match a kernel pipe: an unblocked writer may finish its current burst. */
  release(): void {
    setTimeout(() => {
      this.closeReader()
    }, 0)
  }

  /** Wait until the reader first asks for bytes or closes. */
  async asked(): Promise<void> {
    while (!this.reading && !this.readerClosed) await this.changed()
  }

  /**
   * Read once; abandoning the iterator closes its endpoint. Each read is one
   * chunk as written, unless `joined`: then it takes everything buffered, as
   * a kernel pipe's read does, for a reader that keeps no write boundaries,
   * which behind a writer that filled the pipe wakes once for the lot rather
   * than once per chunk. Chunks side by side in one buffer (a sealed write)
   * pass as one view of it; others are copied together.
   */
  stream(joined = false): AsyncGenerator<Uint8Array> {
    const reader = this.read(joined)
    const abandon = reader.return.bind(reader)
    // A read still waiting for bytes ends now: the generator would finish
    // only when the next chunk came, which may be never.
    reader.return = (value) => {
      if (this.waiting) this.closeReader()
      return abandon(value)
    }
    return reader
  }

  private async *read(joined: boolean): AsyncGenerator<Uint8Array> {
    if (this.reading) throw new Error('byte pipe already has a reader')
    this.reading = true
    this.notify()
    try {
      while (!this.readerClosed) {
        const taken = joined ? this.chunks.splice(0) : this.chunks.splice(0, 1)
        if (taken.length > 0) {
          for (const chunk of taken) this.bytes -= chunk.byteLength
          this.notify()
          const held = this.gate?.() ?? null
          if (held !== null) await held
          yield this.merged(taken)
          this.accepted += taken.length
          this.notify()
        } else if (this.ended) {
          if (this.failure !== undefined) throw this.failure
          return
        } else {
          this.waiting = true
          await this.changed()
          this.waiting = false
        }
      }
    } finally {
      this.release()
    }
  }
}
