import { ConcurrencyLimiter } from '../concurrency/limiter.ts'
import { CHUNK_SIZE } from './cooperative.ts'
import { BytePipe, CAPACITY } from './pipe.ts'
import type { OutputEvent, StreamName } from './types.ts'

/** One ordered output reader, sharing the byte pipe's capacity and chunks. */
export class OutputPipe {
  private readonly pipe: BytePipe
  private readonly streams: StreamName[] = []
  private readonly lock = new ConcurrencyLimiter(1)
  private reading = false

  constructor(capacity = CAPACITY) {
    this.pipe = new BytePipe(capacity)
  }

  get bufferedBytes(): number {
    return this.pipe.bufferedBytes
  }
  get closedReader(): boolean {
    return this.pipe.closedReader
  }

  /** Accept one write in order, waiting for byte capacity. Empty writes have no event. */
  async write(stream: StreamName, data: Uint8Array): Promise<void> {
    const release = await this.lock.acquire()
    try {
      for (let offset = 0; offset < data.byteLength; offset += CHUNK_SIZE) {
        this.streams.push(stream)
        try {
          await this.pipe.write(data.subarray(offset, offset + CHUNK_SIZE))
        } catch (error) {
          this.streams.pop()
          throw error
        }
      }
    } finally {
      release()
    }
  }

  /** End output, preserving accepted events before a late failure. */
  end(error?: unknown): void {
    this.pipe.end(error)
  }

  async drain(): Promise<void> {
    await this.pipe.drain()
  }

  /** Discard unread output and wake pending readers and writers. */
  closeReader(): void {
    this.pipe.closeReader()
    this.streams.length = 0
  }

  /** Read once; close the reader before closing a pending iterator pull. */
  async *events(): AsyncGenerator<OutputEvent> {
    if (this.reading) throw new Error('output pipe already has a reader')
    this.reading = true
    try {
      for await (const data of this.pipe.stream()) {
        if (this.closedReader) return
        const stream = this.streams.shift()
        if (stream === undefined) throw new Error('output stream is missing')
        yield { stream, data }
      }
    } finally {
      this.closeReader()
    }
  }
}
