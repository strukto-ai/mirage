import { assert, expect, it } from 'vitest'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'

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
