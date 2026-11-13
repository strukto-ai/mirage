import { assert, describe, expect, it } from 'vitest'
import { ShellTreeNode } from '../../rs/shell.ts'
import { getFunctionBody } from '../helpers.ts'
import { retainPrograms, shellNode } from './program.ts'
import { parseProgram } from './parse.ts'

describe('owned programs', () => {
  it('retains invocation nodes independently of the parsing scope', () => {
    const program = parseProgram('f() { echo hello; } 2>/dev/null')
    const definition = program.root.namedChildren[0]
    assert(definition)
    const body = getFunctionBody(definition)
    assert(body)
    const first = body[0]
    assert(first)
    const invoke = retainPrograms(body)
    program.release()
    expect(first.text).toContain('echo hello')
    expect(program.references).toBe(1)
    invoke()
    invoke()
    expect(program.references).toBe(0)
    expect(() => first.children[0]?.text).toThrow('released')
  })
})

it('drops the final tree and maps while stale nodes remain reachable', () => {
  const program = parseProgram("echo '" + 'x'.repeat(1048576) + "'")
  const root = program.root
  const child = root.namedChildren[0]
  assert(child)
  const borrowed = root.borrowed
  assert(borrowed instanceof ShellTreeNode)
  const tree = borrowed.tree
  expect(program.offsets).toBeUndefined()
  const hold = program.retain()
  program.release()
  program.release()
  expect(child.text).toContain('echo')
  hold()
  hold()
  expect(program.references).toBe(0)
  expect(() => program.root).toThrow('released')
  expect(program.original).toBe('')
  expect(program.offsets).toBeUndefined()
  expect(() => child.text).toThrow('released')
  expect(() => program.retain()).toThrow('released')
  expect(() => shellNode(root)).toThrow('released')
  expect(tree.table.length).toBe(0)
  expect(tree.source).toBe('')
  tree.dispose()
})

it.each(['echo é😀', 'echo \udcff', 'ec\\\nho é😀', 'cat <<E\né😀\nE\n', "cat <<'E'\n$HOME\nE\n"])(
  'keeps UTF16 coordinates for %s',
  (text) => {
    const program = parseProgram(text)
    expect(program.offsets?.[program.root.endIndex] ?? program.root.endIndex).toBe(text.length)
    expect(program.root.sourceText).toBe(text)
    program.release()
  },
)
