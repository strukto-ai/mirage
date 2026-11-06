import { BytePipe } from './pipe.ts'
import { PipeClosed } from './errors.ts'
import type { ByteSource } from './types.ts'

/**
 * Feed one consuming write through a bounded pipe; finish waits for commit.
 * `joined` hands the consumer everything buffered in each read
 * (`BytePipe.stream`), so writes that come while it is busy reach it as one.
 */
export class ByteWriter {
  readonly pipe = new BytePipe()
  private readonly task: Promise<void>
  private failed = false
  private failure: unknown

  constructor(consume: (source: ByteSource) => Promise<void>, joined = false) {
    this.task = Promise.resolve()
      .then(() => consume(this.pipe.stream(joined)))
      .catch((error: unknown) => {
        this.failed = true
        this.failure = error
      })
      .finally(() => {
        this.pipe.closeReader()
      })
  }

  async write(data: Uint8Array): Promise<void> {
    try {
      await this.pipe.write(data)
    } catch (error) {
      if (error instanceof PipeClosed) {
        await this.task
        if (this.failed) throw this.failure
      }
      throw error
    }
  }

  /** Wait until the consumer asks for its first bytes; one that ended first, as a refused open does, throws its error. */
  async opened(): Promise<void> {
    await this.pipe.asked()
    if (!this.pipe.closedReader) return
    await this.task
    if (this.failed) throw this.failure
  }

  async finish(): Promise<void> {
    this.pipe.end()
    await this.task
    if (this.failed) throw this.failure
  }

  async abort(): Promise<void> {
    this.pipe.end(new Error('Write aborted'))
    await this.task
    this.pipe.closeReader()
  }
}
