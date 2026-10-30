import { expect, it, vi } from 'vitest'
import { ByteSpool } from '@struktoai/mirage-core/io/spool'
import { materialize } from '@struktoai/mirage-core/io/types'
import { shufGeneric } from '@struktoai/mirage-core/commands/builtin/generic/shuf'
import { PathSpec } from '@struktoai/mirage-core/types'
import type { Context } from '@struktoai/mirage-core/commands/config'
import { SeededIdSource } from '@struktoai/mirage-core/utils/ids'
import './spool.ts'

function unexpected(): never {
  throw new Error('unexpected file operand')
}

it('replays spilled bytes through SDK and fetch upload bodies', async () => {
  const spool = new ByteSpool(0)
  const expected = new Uint8Array(70000).map((_, i) => i % 251)
  try {
    await spool.fill(expected)
    const body = await spool.body('sdk')
    if (body instanceof Blob) throw new Error('expected Node readable')
    expect(await materialize(body)).toEqual(expected)
    const blob = await spool.body('fetch')
    if (!(blob instanceof Blob)) throw new Error('expected file-backed Blob')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(expected)
    expect(await spool.read(16380, 17)).toEqual(expected.slice(16380, 16397))
  } finally {
    await spool.close()
  }
  await expect(spool.read(0, 1)).rejects.toThrow('closed')
})

it('streams repeated shuf records larger than the memory budget from disk', async () => {
  const piece = new Uint8Array(16384).fill(120)
  const stores = new Set<ByteSpool>()
  // The spy calls the saved method with its original receiver.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const read = ByteSpool.prototype.read
  const spy = vi.spyOn(ByteSpool.prototype, 'read').mockImplementation(async function (
    this: ByteSpool,
    offset: number,
    size: number,
  ) {
    expect(size).toBeLessThanOrEqual(piece.length)
    stores.add(this)
    return read.call(this, offset, size)
  })
  async function* source() {
    await Promise.resolve()
    for (let record = 0; record < 2; record++) {
      for (let at = 0; at < 17 * 1024 * 1024; at += piece.length) yield piece
      yield Uint8Array.of(10)
    }
  }
  const ctx = {
    stdin: source(),
    flags: { repeat: true, head_count: '2' },
    ids: new SeededIdSource(5),
    cwd: PathSpec.fromStrPath('/'),
    vfs: { kind: 'ram' } as never,
  } as Context
  try {
    const result = await shufGeneric([], [], ctx, unexpected, unexpected)
    if (result === null) throw new Error('shuf declined')
    const [out, io] = result
    if (out === null || out instanceof Uint8Array) throw new Error('shuf must stream')
    let count = 0
    for await (const chunk of out) {
      expect(chunk.length).toBeLessThanOrEqual(piece.length)
      count += chunk.length
    }
    expect(io.exitCode).toBe(0)
    expect(count).toBe(2 * (17 * 1024 * 1024 + 1))
    expect(stores.size).toBeGreaterThan(0)
    expect([...stores].every((store) => store.closed)).toBe(true)
  } finally {
    spy.mockRestore()
  }
})
