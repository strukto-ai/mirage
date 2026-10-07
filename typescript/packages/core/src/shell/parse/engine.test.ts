import { afterEach, expect, it, vi } from 'vitest'
import { Parser, Tree } from 'web-tree-sitter'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'

afterEach(() => vi.restoreAllMocks())

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
