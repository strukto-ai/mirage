import { OutputStream, closeQuietly } from './stream.ts'
import { CHUNK_SIZE, chunks } from './cooperative.ts'
import { concat } from '../utils/bytes.ts'
import type { ByteSource } from './types.ts'

export const MEMORY_LIMIT = 1024 * 1024
const IO_BUFFER_SIZE = 256 * 1024

export interface SpoolStore {
  append(data: Uint8Array): Promise<void>
  read(offset: number, size: number): Promise<Uint8Array>
  close(): Promise<void>
  body?(kind: 'fetch' | 'sdk'): Promise<Blob | AsyncIterable<Uint8Array>>
}

export type SpoolFactory = () => Promise<SpoolStore>
let factory: SpoolFactory | null = null

/** Install the execution host's private scratch storage. */
export function setSpoolFactory(value: SpoolFactory | null): void {
  factory = value
}

/** Retain replayable bytes, spilling through the host's scratch storage. */
export class ByteSpool {
  size = 0
  private memory: Uint8Array[] = []
  private store: SpoolStore | null = null
  private closed = false
  private pendingSize = 0
  private cache: Uint8Array = new Uint8Array()
  private cacheOffset = 0

  constructor(readonly memoryLimit = MEMORY_LIMIT) {
    if (!Number.isSafeInteger(memoryLimit) || memoryLimit < 0) {
      throw new RangeError('spool memory limit must be nonnegative')
    }
  }

  async append(data: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('spool is closed')
    this.cache = new Uint8Array()
    if (this.store === null && this.size + data.length > this.memoryLimit && factory !== null) {
      this.store = await factory()
      for (const part of this.memory) await this.store.append(part)
      this.memory = []
      this.pendingSize = 0
    }
    let offset = 0
    while (offset < data.length) {
      const tail = this.memory.at(-1)
      if (tail !== undefined && tail.length < CHUNK_SIZE) {
        const count = Math.min(CHUNK_SIZE - tail.length, data.length - offset)
        const extended = new Uint8Array(tail.buffer, tail.byteOffset, tail.length + count)
        extended.set(data.subarray(offset, offset + count), tail.length)
        this.memory[this.memory.length - 1] = extended
        offset += count
      } else {
        const count = Math.min(CHUNK_SIZE, data.length - offset)
        const block = new Uint8Array(CHUNK_SIZE)
        block.set(data.subarray(offset, offset + count))
        this.memory.push(block.subarray(0, count))
        offset += count
      }
    }
    this.pendingSize += data.length
    if (this.store !== null && this.pendingSize >= IO_BUFFER_SIZE) await this.flush()
    this.size += data.length
  }

  private async flush(): Promise<void> {
    if (this.store !== null && this.pendingSize > 0) {
      await this.store.append(concat(this.memory))
      this.memory = []
      this.pendingSize = 0
    }
  }

  async fill(source: ByteSource): Promise<void> {
    for await (const chunk of chunks(source)) await this.append(chunk)
  }

  async read(offset: number, size: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0)
      throw new RangeError('spool window must be nonnegative')
    if (this.closed) throw new Error('spool is closed')
    if (this.store !== null) {
      await this.flush()
      if (size > CHUNK_SIZE) return this.store.read(offset, size)
      if (!(this.cacheOffset <= offset && offset + size <= this.cacheOffset + this.cache.length)) {
        this.cacheOffset = Math.floor(offset / IO_BUFFER_SIZE) * IO_BUFFER_SIZE
        this.cache = await this.store.read(
          this.cacheOffset,
          Math.max(IO_BUFFER_SIZE, offset + size - this.cacheOffset),
        )
      }
      const start = offset - this.cacheOffset
      return this.cache.slice(start, start + size)
    }
    const result = new Uint8Array(Math.max(0, Math.min(size, this.size - offset)))
    let position = 0
    let written = 0
    for (const part of this.memory) {
      if (position + part.length > offset && written < result.length) {
        const start = Math.max(0, offset - position)
        const count = Math.min(part.length - start, result.length - written)
        result.set(part.subarray(start, start + count), written)
        written += count
      }
      position += part.length
      if (written === result.length) break
    }
    return result
  }

  async *stream(offset = 0, size?: number): AsyncGenerator<Uint8Array> {
    const end = size === undefined ? this.size : Math.min(this.size, offset + size)
    while (offset < end) {
      const data = await this.read(offset, Math.min(CHUNK_SIZE, end - offset))
      if (data.length === 0) return
      offset += data.length
      yield data
    }
  }

  async output(): Promise<ByteSource> {
    if (this.size <= this.memoryLimit) {
      const data = await this.read(0, this.size)
      await this.close()
      return data
    }
    return new OutputStream(this.stream(), () => this.close())
  }

  async body(kind: 'fetch' | 'sdk'): Promise<Uint8Array | Blob | AsyncIterable<Uint8Array>> {
    if (this.closed) throw new Error('spool is closed')
    await this.flush()
    if (this.store?.body !== undefined) return this.store.body(kind)
    if (this.store !== null) throw new Error('scratch storage cannot provide an upload body')
    return this.read(0, this.size)
  }

  async close(): Promise<void> {
    this.closed = true
    this.memory = []
    this.cache = new Uint8Array()
    const store = this.store
    this.store = null
    if (store !== null) await store.close()
  }
}

/**
 * Hold `source` in a spool: its bytes when they fit in memory, a stream that
 * owns the spool past that, null when it is empty. Mirrors Python's spooled.
 */
export async function spooled(source: ByteSource | null): Promise<ByteSource | null> {
  const store = new ByteSpool()
  try {
    await store.fill(source ?? new Uint8Array())
    if (store.size === 0) {
      await store.close()
      return null
    }
    return await store.output()
  } catch (error) {
    await store.close()
    throw error
  }
}

/**
 * `spooled` over both outputs of a run; when one fails, what the other holds
 * is closed. Mirrors Python's spooled_pair.
 */
export async function spooledPair(
  stdout: ByteSource | null,
  stderr: ByteSource | null,
): Promise<[ByteSource | null, ByteSource | null]> {
  let out: ByteSource | null
  try {
    out = await spooled(stdout)
  } catch (error) {
    await closeQuietly(stderr)
    throw error
  }
  try {
    return [out, await spooled(stderr)]
  } catch (error) {
    await closeQuietly(out)
    throw error
  }
}

export class ByteSlice {
  constructor(
    readonly source: ByteSpool,
    readonly offset: number,
    readonly size: number,
  ) {}
  stream(): AsyncGenerator<Uint8Array> {
    return this.source.stream(this.offset, this.size)
  }
}
