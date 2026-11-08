import { expect, it } from 'vitest'
import { columnGeneric } from './column.ts'
import { MemoryBudget, runWithMemory } from '../../../io/memory.ts'
import { materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { Context } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { parseCommand, parseToKwargs } from '../../spec/parser.ts'

it.each([false, true])('column accepts bytes and streams: %s', async (streamed) => {
  const body = new TextEncoder().encode('a 1\nlong 2\n')
  async function* pieces(): AsyncGenerator<Uint8Array> {
    await Promise.resolve()
    for (const byte of body) yield Uint8Array.of(byte)
  }
  const [out, io] = await columnGeneric(
    [],
    {
      cwd: PathSpec.fromStrPath('/'),
      flags: { table: true },
      stdin: streamed ? pieces() : body,
    } as Context,
    () => {
      throw new Error('no operands')
    },
  )
  expect(new TextDecoder().decode(await materialize(out))).toBe('a     1\nlong  2\n')
  expect(io.exitCode).toBe(0)
})

it('feeds large column operands without host materialization', async () => {
  const block = new TextEncoder().encode(' '.repeat(16383) + '\n')
  let readBytes = 0
  async function* read(): AsyncGenerator<Uint8Array> {
    await Promise.resolve()
    for (let i = 0; i < 2176; i++) {
      readBytes += block.length
      yield block
    }
  }
  await runWithMemory(new MemoryBudget(32 << 20, () => 0), async () => {
    const [out, io] = await columnGeneric(
      [PathSpec.fromStrPath('/f')],
      { cwd: PathSpec.fromStrPath('/'), flags: { table: true }, stdin: null } as Context,
      read,
    )
    expect(await materialize(out)).toEqual(new Uint8Array())
    expect(io.exitCode).toBe(0)
  })
  expect(readBytes).toBe(34 << 20)
})

async function ranColumn(
  words: string[],
  body = 'a 1\nlong 2\n',
): Promise<[string, string, number]> {
  const parsed = parseCommand(specOf('column'), words, '/', 'column')
  const [out, io] = await columnGeneric(
    [],
    {
      cwd: PathSpec.fromStrPath('/'),
      flags: parseToKwargs(parsed),
      stdin: new TextEncoder().encode(body),
    } as Context,
    () => {
      throw new Error('no operands')
    },
  )
  const stdout = new TextDecoder().decode(await materialize(out))
  return [stdout, new TextDecoder().decode(await materialize(io.stderr)), io.exitCode]
}

it.each([
  [['--table', '--table-columns', 'A,B'], 'A     B\na     1\nlong  2\n'],
  [['-t', '-R', '2', '-N', 'A,B'], 'A     B\na     1\nlong  2\n'],
  [['-t', '--table-hide', '1'], '1\n2\n'],
  [['-t', '--table-order', '2'], '1  a\n2  long\n'],
  [['-t', '--table-columns-limit', '1'], 'a 1\nlong 2\n'],
  [['--fillrows', '--output-width', '20'], 'a 1\tlong 2\n'],
  [
    ['--json', '--table-name', 't', '-N', 'A,B'],
    '{\n   "t": [\n      {\n         "a": "a",\n         "b": "1"\n      },{\n         "a": "long",\n         "b": "2"\n      }\n   ]\n}\n',
  ],
])('column reads its table options: %j', async (words, stdout) => {
  expect(await ranColumn(words)).toEqual([stdout, '', 0])
})

it.each([
  [['-c', 'abc'], "column: invalid columns argument: 'abc'\n"],
  [['-N', 'A'], 'column: option --table required for all --table-*\n'],
  [['-t', '-R', '9'], "column: undefined column name '9'\n"],
])('column refuses as the real one does: %j', async (words, stderr) => {
  expect(await ranColumn(words)).toEqual(['', stderr, 1])
})
