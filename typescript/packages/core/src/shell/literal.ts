import { shellJoin } from './join.ts'
import type { TSNodeLike } from './types.ts'

/** Construct literal argument words; no argv content is shell-parsed. */
export function literalTree(argv: readonly string[]): TSNodeLike {
  if (argv.length === 0 || !argv[0] || argv.some((arg) => arg.includes('\0')))
    throw new Error('argv must name a program and contain no NUL bytes')
  let offset = 0
  const words = argv.map((arg, i): TSNodeLike => {
    const text = "'" + arg + "'"
    const word: TSNodeLike = {
      type: 'raw_string',
      text,
      children: [],
      namedChildren: [],
      startIndex: offset,
      endIndex: offset + text.length,
      isNamed: true,
    }
    offset += text.length + 1
    if (i !== 0) return word
    const name: TSNodeLike = {
      isNamed: true,
      type: 'command_name',
      text: arg,
      children: [word],
      namedChildren: [word],
      startIndex: 0,
      endIndex: text.length,
    }
    word.parent = name
    return name
  })
  const text = shellJoin(argv)
  const command: TSNodeLike = {
    isNamed: true,
    type: 'command',
    text,
    children: words,
    namedChildren: words,
    startIndex: 0,
    endIndex: text.length,
  }
  for (const word of words) word.parent = command
  const program: TSNodeLike = {
    isNamed: true,
    type: 'program',
    text,
    children: [command],
    namedChildren: [command],
    startIndex: 0,
    endIndex: text.length,
  }
  command.parent = program
  return program
}
