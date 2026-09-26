import { describe, expect, it } from 'vitest'
import { literalTree } from './literal.ts'

describe('literalTree', () => {
  it('is one command of quoted words', () => {
    const tree = literalTree(['printf', '%s', '$(whoami)'])
    const command = tree.children[0]
    expect([tree.type, command?.type]).toEqual(['program', 'command'])
    expect(tree.text).toBe("printf %s '$(whoami)'")
    expect(command?.children.map((c) => c.type)).toEqual([
      'command_name',
      'raw_string',
      'raw_string',
    ])
    expect(command?.children[0]?.text).toBe('printf')
    expect(command?.children.slice(1).map((c) => c.text)).toEqual(["'%s'", "'$(whoami)'"])
    expect(command?.children.every((c) => c.parent === command)).toBe(true)
  })

  it.each([[[]], [['']], [['echo', 'a\0b']]])(
    'refuses argv naming no program or holding NUL: %j',
    (argv) => {
      expect(() => literalTree(argv)).toThrow('argv must name a program')
    },
  )
})
