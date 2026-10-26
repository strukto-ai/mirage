import { expect, it } from 'vitest'
import type { ProgramNode } from './program.ts'
import { ParseScope } from './scope.ts'

it('a released scope releases every program it parsed', () => {
  const scope = new ParseScope()
  const roots = [
    'echo hi',
    '((echo inner); echo outer)',
    'cat <<E\nhi\nE',
    'v=$(echo x) 2>/dev/null; echo "$v"',
  ].map((line) => scope.parse(line) as ProgramNode)
  scope.release()
  expect(roots.map((root) => root.program.references)).toEqual([0, 0, 0, 0])
  expect(() => scope.parse('echo')).toThrow(/released/)
})
