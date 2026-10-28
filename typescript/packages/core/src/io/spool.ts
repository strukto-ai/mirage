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

/**
 * Retain replayable bytes, spilling through the host's scratch storage. An
 * append that fails leaves no telling which of its bytes were kept, so every
 * call after it fails too, rather than read bytes from where the append never
 * put them.
 */
export class ByteSpool {
  size = 0
  closed = false
  private memory: Uint8Array[] = []
  private store: SpoolStore | null = null
  private lost: unknown = undefined
  private pendingSize = 0
  private cache: Uint8Array = new Uint8Array()
  private cacheOffset = 0
  private turn: Promise<unknown> = Promise.resolve()

  constructor(readonly memoryLimit = MEMORY_LIMIT) {
    if (!Number.isSafeInteger(memoryLimit) || memoryLimit < 0) {
      throw new RangeError('spool memory limit must be nonnegative')
    }
  }

  /** Run `fn` once every call before it has settled, as Python's lock holds them. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.turn.then(fn)
    this.turn = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  append(data: Uint8Array): Promise<void> {
    return this.locked(async () => {
      this.usable()
      try {
        await this.appendNow(data)
      } catch (error) {
        this.lost = error
        throw error
      }
    })
  }

  private usable(): void {
    if (this.closed) throw new Error('spool is closed')
    if (this.lost !== undefined) {
      throw Object.assign(new Error('spool lost a write', { cause: this.lost }), { code: 'EIO' })
    }
  }

  private async appendNow(data: Uint8Array): Promise<void> {
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
    return this.locked(() => this.readNow(offset, size))
  }

  private async readNow(offset: number, size: number): Promise<Uint8Array> {
    this.usable()
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
    let index = Math.floor(offset / CHUNK_SIZE)
    let start = offset - index * CHUNK_SIZE
    for (let written = 0; written < result.length; index++, start = 0) {
      const part = this.memory[index]
      if (part === undefined) break
      const count = Math.min(part.length - start, result.length - written)
      result.set(part.subarray(start, start + count), written)
      written += count
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

  body(kind: 'fetch' | 'sdk'): Promise<Uint8Array | Blob | AsyncIterable<Uint8Array>> {
    return this.locked(async () => {
      this.usable()
      await this.flush()
      if (this.store?.body !== undefined) return this.store.body(kind)
      if (this.store !== null) throw new Error('scratch storage cannot provide an upload body')
      return this.readNow(0, this.size)
    })
  }

  close(): Promise<void> {
    return this.locked(() => this.closeNow())
  }

  private async closeNow(): Promise<void> {
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

/** A window of a spool, sized and sliced as the bytes it stands for. */
export class ByteSlice {
  constructor(
    readonly source: ByteSpool,
    readonly offset: number,
    readonly size: number,
  ) {}

  get byteLength(): number {
    return this.size
  }

  /** As `Uint8Array.subarray`, for the nonnegative bounds a buffer slices by. */
  subarray(start = 0, end = this.size): ByteSlice {
    const from = Math.min(start, this.size)
    return new ByteSlice(this.source, this.offset + from, Math.max(0, Math.min(end, this.size) - from))
  }
  stream(): AsyncGenerator<Uint8Array> {
    return this.source.stream(this.offset, this.size)
  }
}
