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

  it('reports diagnostics in the original Unicode source after recovery', async () => {
    const parser = await getTestParser()
    const line = 'echo é💡; value=x 2>/dev/null; fi'
    const program = parser.parseProgram(line)
    try {
      expect(program.diagnostics[0]?.offending).toBe('fi')
      const diagnostic = program.diagnostics[0]
      assert(diagnostic)
      const span = diagnostic.span
      expect(line.slice(span.start, span.end)).toBe('fi')
      expect(program.root.text).toBe(line)
    } finally {
      program.release()
    }
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

it('releases partial native allocations when a recovery parse throws', async () => {
  const parser = await getTestParser()
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with apply(this, args) below.
  const original = Parser.prototype.parse
  const releases = vi.spyOn(Tree.prototype, 'delete')
  let tree: Tree | null = null
  vi.spyOn(Parser.prototype, 'parse').mockImplementation(function (this: Parser, ...args) {
    if (tree !== null) throw new Error('injected recovery failure')
    tree = original.apply(this, args)
    return tree
  })
  expect(() => parser.parseProgram('cat <<E\nhi\nE')).toThrow('injected recovery failure')
  expect(releases.mock.contexts.filter((t) => t === tree)).toHaveLength(1)
})
