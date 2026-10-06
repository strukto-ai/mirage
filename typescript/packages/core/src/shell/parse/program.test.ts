import { afterEach, assert, describe, expect, it, vi } from 'vitest'
import { Parser, Tree } from 'web-tree-sitter'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { functionTable, releaseFunctions } from '../../workspace/session/functions.ts'
import { getFunctionBody } from '../helpers.ts'
import { ParseScope } from './scope.ts'
import { retainPrograms } from './program.ts'

afterEach(() => vi.restoreAllMocks())

describe('owned programs', () => {
  it('releases every native retry and the final tree exactly once', async () => {
    const parser = await getTestParser()
    const allocations = vi.spyOn(Parser.prototype, 'parse')
    const releases = vi.spyOn(Tree.prototype, 'delete')
    const scope = new ParseScope(parser)
    for (const line of [
      'echo hi',
      '((echo inner); echo outer)',
      'echo /a/$b/$c.json',
      'cat <<E\nhi\nE',
      'time ! true',
      'v=$(echo x) 2>/dev/null; echo "$v"',
      'echo "unterminated',
    ])
      scope.parse(line)
    scope.release()
    const trees = allocations.mock.results
      .filter((r) => r.type === 'return' && r.value !== null)
      .map((r) => r.value as Tree)
    expect(trees.length).toBeGreaterThan(7)
    for (const tree of trees)
      expect(releases.mock.contexts.filter((t) => t === tree)).toHaveLength(1)
  })

  it('retains function and invocation leases independently of their defining line', async () => {
    const parser = await getTestParser()
    const program = parser.parseProgram('f() { echo hello; } 2>/dev/null')
    const definition = program.root.namedChildren[0]
    assert(definition)
    const body = getFunctionBody(definition)
    assert(body)
    const first = body[0]
    assert(first)
    const functions = functionTable({ f: body })
    const invoke = retainPrograms(body)
    program.release()
    delete functions.f
    expect(first.text).toContain('echo hello')
    expect(program.references).toBe(1)
    invoke()
    invoke()
    expect(program.references).toBe(0)
    expect(() => first.children[0]?.text).toThrow('released')
    releaseFunctions(functions)
  })
})

it.each([
  'value=x 2>/dev/null; echo done',
  '  value=é💡 2>/dev/null; echo done',
  'value=$(echo x) 2>/dev/null && echo done',
])('preserves source and siblings through assignment recovery: %s', async (line) => {
  const program = (await getTestParser()).parseProgram(line)
  try {
    expect(program.diagnostics).toEqual([])
    const pending = [program.root]
    while (pending.length) {
      const node = pending.pop()
      assert(node)
      expect(node.text).toBe(line.slice(node.startIndex, node.endIndex))
      const children = node.children
      for (const [index, child] of children.entries()) {
        expect(node.child(index)?.text).toBe(child.text)
        if (index + 1 < children.length)
          expect(child.nextSibling?.text).toBe(children[index + 1]?.text)
        if (index > 0) expect(child.previousSibling?.text).toBe(children[index - 1]?.text)
      }
      pending.push(...children)
    }
  } finally {
    program.release()
  }
})

it('diagnoses a program once, when first read, and frees what it parsed', async () => {
  const parser = await getTestParser()
  const parses = vi.spyOn(Parser.prototype, 'parse')
  const releases = vi.spyOn(Tree.prototype, 'delete')
  const program = parser.parseProgram('echo $(echo a |)')
  try {
    const parsed = parses.mock.calls.length
    expect(program.diagnostics).toHaveLength(1)
    expect(program.diagnostics).toBe(program.diagnostics)
    const nested = parses.mock.results
      .slice(parsed)
      .filter((r) => r.type === 'return' && r.value !== null)
      .map((r) => r.value as Tree)
    expect(nested.length).toBeGreaterThan(0)
    for (const tree of nested)
      expect(releases.mock.contexts.filter((t) => t === tree)).toHaveLength(1)
  } finally {
    program.release()
  }
  expect(() => program.diagnostics).toThrow('released')
})
