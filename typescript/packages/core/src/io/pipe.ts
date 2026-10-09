import { CHUNK_SIZE } from './cooperative.ts'
import { PipeClosed } from './errors.ts'

export const CAPACITY = 4 * CHUNK_SIZE

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

  private changed(): Promise<void> {
    return new Promise((resolve) => this.wake.push(resolve))
  }

  /** Accept bytes in bounded chunks, waiting for available capacity. */
  async write(data: Uint8Array): Promise<void> {
    for (let start = 0; start < data.byteLength; start += CHUNK_SIZE) {
      const length = Math.min(CHUNK_SIZE, data.byteLength - start)
      while (this.bytes + length > this.capacity && !this.readerClosed && !this.ended)
        await this.changed()
      if (this.readerClosed || this.ended) throw new PipeClosed()
      const chunk = new Uint8Array(data.subarray(start, start + length))
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

  /** Read once; abandoning the iterator closes its endpoint. */
  async *stream(): AsyncGenerator<Uint8Array> {
    if (this.reading) throw new Error('byte pipe already has a reader')
    this.reading = true
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
