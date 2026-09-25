import { assert, expect, it, vi } from 'vitest'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import { substringOperands } from './substring.ts'

it('expands operands only when requested', async () => {
  const root = (await getTestParser()).parse('echo ${x:$offset:$length}')
  const node = root.namedChildren[0]?.namedChildren.at(-1)
  assert(node)
  const expand = vi.fn().mockResolvedValueOnce('1').mockResolvedValueOnce('2')
  const operands = substringOperands(node, expand)
  expect(await operands.next()).toEqual({ value: '1', done: false })
  expect(expand).toHaveBeenCalledTimes(1)
  expect(await operands.next()).toEqual({ value: '2', done: false })
  expect(expand).toHaveBeenCalledTimes(2)
  expect((await operands.next()).done).toBe(true)
})

it.each([
  ['${x:1?2:3:4}', [], ['1?2:3', '4']],
  ['${x:(1?2:3):4}', [], ['(1?2:3)', '4']],
  ['${x:a[1?2:3]:4}', ['a'], ['a[1?2:3]', '4']],
  ['${x:$offset:2}', ['1?2:3'], ['1?2:3', '2']],
  ['${x:"1?2:3":4}', ['1?2:3'], ['1?2:3', '4']],
  ['${x:$(echo 1):${n:-2}}', ['1', '2'], ['1', '2']],
] as [string, string[], string[]][])(
  'splits only source separators: %s',
  async (source, expanded, expected) => {
    const root = (await getTestParser()).parse('echo ' + source)
    const node = root.namedChildren[0]?.namedChildren.at(-1)
    assert(node)
    let index = 0
    const values: string[] = []
    for await (const value of substringOperands(node, () =>
      Promise.resolve(expanded[index++] ?? ''),
    ))
      values.push(value)
    expect(values).toEqual(expected)
  },
)
