import { makeAbortError } from '../utils/abort.ts'
import { CHUNK_SIZE } from './cooperative.ts'
import { PipeClosed } from './errors.ts'

export const CAPACITY = 4 * CHUNK_SIZE

/**
 * Buffers their producer never writes again, such as mirage-rs output copied
 * out of linear memory. A pipe keeps a chunk of one no larger than its
 * capacity as written, so a reader holding a few bytes pins no more than the
 * pipe may buffer; it copies a chunk of any other buffer, in case the writer
 * reuses it.
 */
export const SEALED = new WeakSet<ArrayBufferLike>()

/** One reader and bounded asynchronous writes. Closing either endpoint wakes writers. */
export class BytePipe {
  constructor(private readonly capacity = CAPACITY) {
    if (!Number.isSafeInteger(capacity) || capacity < CHUNK_SIZE)
      throw new Error('pipe capacity must be an integer from 16384 to 9007199254740991')
  }
  private chunks: Uint8Array[] = []
  private bytes = 0
  private ended = false
  private readerClosed = false
  private reading = false
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
      const changed = (): void => {
        signal?.removeEventListener('abort', aborted)
        resolve()
      }
      const aborted = (): void => {
        this.wake = this.wake.filter((wake) => wake !== changed)
        signal?.removeEventListener('abort', aborted)
        reject(makeAbortError(signal))
      }
      this.wake.push(changed)
      signal?.addEventListener('abort', aborted, { once: true })
    })
  }

  /** Accept bytes in bounded chunks, waiting for available capacity. */
  async write(data: Uint8Array, signal?: AbortSignal): Promise<void> {
    for (let start = 0; start < data.byteLength; start += CHUNK_SIZE) {
      signal?.throwIfAborted()
      const length = Math.min(CHUNK_SIZE, data.byteLength - start)
      while (this.bytes + length > this.capacity && !this.readerClosed && !this.ended)
        await this.changed(signal)
      if (signal?.aborted === true) throw makeAbortError(signal)
      if (this.readerClosed || this.ended) throw new PipeClosed()
      const piece = data.subarray(start, start + length)
      const lent = SEALED.has(data.buffer) && data.buffer.byteLength <= this.capacity
      const chunk = lent ? piece : new Uint8Array(piece)
      this.chunks.push(chunk)
      this.bytes += length
      this.delivered += 1
      this.notify()
    }
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

  /** Read once; abandoning the iterator closes its endpoint. */
  async *stream(): AsyncGenerator<Uint8Array> {
    if (this.reading) throw new Error('byte pipe already has a reader')
    this.reading = true
    this.notify()
    try {
      while (!this.readerClosed) {
        const chunk = this.chunks.shift()
        if (chunk !== undefined) {
          this.bytes -= chunk.byteLength
          this.notify()
          yield chunk
          this.accepted += 1
          this.notify()
        } else if (this.ended) {
          if (this.failure !== undefined) throw this.failure
          return
        } else {
          await this.changed()
        }
      }
    } finally {
      this.release()
    }
  }
}
