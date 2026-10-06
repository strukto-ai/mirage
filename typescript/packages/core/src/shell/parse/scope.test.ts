import { afterEach, expect, it, vi } from 'vitest'
import { Parser, Tree } from 'web-tree-sitter'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { ParseScope } from './scope.ts'

afterEach(() => vi.restoreAllMocks())

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
  for (const tree of trees) expect(releases.mock.contexts.filter((t) => t === tree)).toHaveLength(1)
})
