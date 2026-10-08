import { assert, expect, it } from 'vitest'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { checkSyntax } from './index.ts'
import { findSyntaxIssue } from './syntax.ts'

it.each(['echo ${x:$offset:2}', 'if false; then echo ${x:.2f}; fi', 'echo ${x:$(echo 1):${n:-2}}'])(
  'defers balanced substring arithmetic: %s',
  async (source) => {
    const root = (await getTestParser()).parse(source)
    expect(checkSyntax(source)).toBeNull()
    expect(findSyntaxIssue(root)).toBeNull()
    expect(root.text).toBe(source)
  },
)

it('keeps nested nodes and source offsets', async () => {
  const source = 'echo é ${x:$(echo 1):$n}'
  const root = (await getTestParser()).parse(source)
  const expansion = root.namedChildren[0]?.namedChildren.at(-1)
  assert(expansion)
  const stack = [expansion]
  const kinds: string[] = []
  while (stack.length) {
    const node = stack.pop()
    assert(node)
    expect(node.text).toBe(source.slice(node.startIndex, node.endIndex))
    kinds.push(node.type)
    stack.push(...node.children)
  }
  expect(kinds).toContain('command_substitution')
  expect(kinds).toContain('simple_expansion')
})

it.each(['echo ${x:$n', 'echo ${x:$(echo 1)}; if'])('rejects unbalanced shell: %s', (source) => {
  expect(checkSyntax(source)).not.toBeNull()
})
