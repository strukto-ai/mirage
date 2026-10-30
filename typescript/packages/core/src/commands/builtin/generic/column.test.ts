import { expect, it } from 'vitest'
import { columnGeneric } from './column.ts'
import { MemoryBudget, runWithMemory } from '../../../io/memory.ts'
import { materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { Context } from '../../config.ts'

it.each([false, true])('column accepts bytes and streams: %s', async (streamed) => {
  const body = new TextEncoder().encode('a 1\nlong 2\n')
  async function* pieces(): AsyncGenerator<Uint8Array> {
    await Promise.resolve()
    for (const byte of body) yield Uint8Array.of(byte)
  }
  const [out, io] = await columnGeneric([], {cwd: PathSpec.fromStrPath('/'), flags: {t: true}, stdin: streamed ? pieces() : body} as Context, () => { throw new Error('no operands') })
  expect(new TextDecoder().decode(await materialize(out))).toBe('a     1\nlong  2\n')
  expect(io.exitCode).toBe(0)
})

it('feeds large column operands without host materialization', async () => {
  const block = new TextEncoder().encode(' '.repeat(16383) + '\n')
  let readBytes = 0
  async function* read(): AsyncGenerator<Uint8Array> {
    await Promise.resolve()
    for (let i = 0; i < 2176; i++) { readBytes += block.length; yield block }
  }
  await runWithMemory(new MemoryBudget(32 << 20, () => 0), async () => {
    const [out, io] = await columnGeneric([PathSpec.fromStrPath('/f')], {cwd: PathSpec.fromStrPath('/'), flags: {t: true}, stdin: null} as Context, read)
    expect(await materialize(out)).toEqual(new Uint8Array())
    expect(io.exitCode).toBe(0)
  })
  expect(readBytes).toBe(34 << 20)
})
