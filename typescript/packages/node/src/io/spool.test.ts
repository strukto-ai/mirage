import { uniqGeneric } from '@struktoai/mirage-core/commands/builtin/generic/uniq'
import { xxdGeneric } from '@struktoai/mirage-core/commands/builtin/generic/xxd'
import { checksumGeneric } from '@struktoai/mirage-core/commands/builtin/generic/checksum'
import { MemoryBudget, runWithMemory } from '@struktoai/mirage-core/io/memory'
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

it('spills uniq OUTPUT before overwriting its own input under the default budget', async () => {
  const chunk = new TextEncoder().encode('a'.repeat(8191) + '\n' + 'b'.repeat(8191) + '\n')
  let complete = false
  let written = 0
  async function* read(): AsyncGenerator<Uint8Array> {
    await Promise.resolve()
    for (let i = 0; i < 2176; i++) yield chunk
    complete = true
  }
  const path = PathSpec.fromStrPath('/same')
  await runWithMemory(new MemoryBudget(32 << 20, () => 0), async () => {
    const result = await uniqGeneric(
      [path, path],
      { flags: {}, stdin: null, cwd: PathSpec.fromStrPath('/') } as Context,
      read,
      async (_path, source) => {
        expect(complete).toBe(true)
        expect(source).not.toBeInstanceOf(Uint8Array)
        for await (const part of source as AsyncIterable<Uint8Array>) written += part.length
      },
    )
    if (result === null) throw new Error("missing command result")
    const [out, io] = result
    expect(await materialize(out)).toEqual(new Uint8Array())
    expect(io.exitCode).toBe(0)
  })
  expect(written).toBe(34 << 20)
})

it('patches an existing xxd output larger than the default memory budget', async () => {
  const size = 34 << 20
  const input = PathSpec.fromStrPath('/dump')
  const target = PathSpec.fromStrPath('/large')
  const encoder = new TextEncoder()
  let written = 0
  let last = 0
  async function* read(path: PathSpec): AsyncGenerator<Uint8Array> {
    await Promise.resolve()
    if (path === input) yield encoder.encode(`00000000: 6162\n${(size - 1).toString(16)}: 7a\n`)
    else {
      const chunk = new Uint8Array(16384).fill(120)
      for (let i = 0; i < size / chunk.length; i++) yield chunk
    }
  }
  await runWithMemory(new MemoryBudget(32 << 20, () => 0), async () => {
    const [, io] = await xxdGeneric(
      [input, target],
      { flags: { r: true }, stdin: null, cwd: PathSpec.fromStrPath('/') } as Context,
      read,
      async (_path, source) => {
        expect(source).not.toBeInstanceOf(Uint8Array)
        for await (const part of source as AsyncIterable<Uint8Array>) {
          if (written === 0) expect(part.subarray(0, 4)).toEqual(encoder.encode('abxx'))
          written += part.length
          last = part.at(-1) ?? 0
        }
      },
    )
    expect(io.exitCode).toBe(0)
  })
  expect(written).toBe(size)
  expect(last).toBe(122)
})

it('streams a checksum list larger than the default memory budget', async () => {
  const encoder = new TextEncoder()
  const chunk = encoder.encode(' '.repeat(16383) + '\n')
  async function* read(path: PathSpec): AsyncGenerator<Uint8Array> {
    await Promise.resolve()
    if (path.virtual === '/sums') {
      for (let i = 0; i < 2176; i++) yield chunk
      yield encoder.encode('2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881  /f\n')
    } else yield encoder.encode('x')
  }
  await runWithMemory(new MemoryBudget(32 << 20, () => 0), async () => {
    const result = await checksumGeneric(
      [PathSpec.fromStrPath('/sums')],
      { flags: { check: true }, stdin: null, cwd: PathSpec.fromStrPath('/') } as Context,
      read,
      'sha256sum',
    )
    if (result === null) throw new Error("missing command result")
    const [out, io] = result
    expect(new TextDecoder().decode(await materialize(out))).toBe('/f: OK\n')
    expect(io.exitCode).toBe(0)
  })
})
