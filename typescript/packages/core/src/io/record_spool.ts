import { ByteSpool, MEMORY_LIMIT } from './spool.ts'

/** Replay variable-length records without retaining their byte offsets in RAM. */
export class RecordSpool {
  readonly data: ByteSpool
  readonly index: ByteSpool
  count = 0

  constructor(memoryLimit = MEMORY_LIMIT) {
    this.data = new ByteSpool(memoryLimit)
    this.index = new ByteSpool(memoryLimit)
  }

  async append(record: Uint8Array): Promise<void> {
    const entry = new Uint8Array(16)
    const view = new DataView(entry.buffer)
    view.setBigUint64(0, BigInt(this.data.size), true)
    view.setBigUint64(8, BigInt(record.length), true)
    await this.data.append(record)
    await this.index.append(entry)
    this.count++
  }

  async indexDelimited(separator: number): Promise<void> {
    if (this.count !== 0 || !Number.isInteger(separator) || separator < 0 || separator > 255)
      throw new RangeError('record index requires an empty index and one-byte separator')
    let start = 0
    let offset = 0
    const append = async (end: number): Promise<void> => {
      const entry = new Uint8Array(16)
      const view = new DataView(entry.buffer)
      view.setBigUint64(0, BigInt(start), true)
      view.setBigUint64(8, BigInt(end - start), true)
      await this.index.append(entry)
      this.count++
      start = end
    }
    for await (const chunk of this.data.stream()) {
      let position = 0
      for (;;) {
        const found = chunk.indexOf(separator, position)
        if (found < 0) break
        await append(offset + found + 1)
        position = found + 1
      }
      offset += chunk.length
    }
    if (start < this.data.size) await append(this.data.size)
  }

  async window(index: number): Promise<[number, number]> {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.count)
      throw new RangeError('record index out of range')
    const entry = await this.index.read(index * 16, 16)
    const view = new DataView(entry.buffer, entry.byteOffset, entry.byteLength)
    return [Number(view.getBigUint64(0, true)), Number(view.getBigUint64(8, true))]
  }

  async read(index: number): Promise<Uint8Array> {
    const [offset, size] = await this.window(index)
    return this.data.read(offset, size)
  }

  async *stream(index: number): AsyncGenerator<Uint8Array> {
    const [offset, size] = await this.window(index)
    yield* this.data.stream(offset, size)
  }

  async close(): Promise<void> {
    try {
      await this.data.close()
    } finally {
      await this.index.close()
    }
  }
}
