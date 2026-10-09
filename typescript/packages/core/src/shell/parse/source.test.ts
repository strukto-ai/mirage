import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { Language, Parser } from 'web-tree-sitter'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import type { TSNodeLike } from '../types.ts'
import { joinContinuations, type ShellParser } from './index.ts'

const require = createRequire(import.meta.url)
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let parser: ShellParser
let rawParser: Parser

beforeAll(async () => {
  parser = await getTestParser()
  rawParser = new Parser()
  rawParser.setLanguage(await Language.load(grammarWasm))
})

describe('sourceOffsets', () => {
  it.each([
    ['continuation', 'echo A; \\\n fi'],
    ['rebrace', 'echo /api/$c/$id.json; fi'],
    ['bang', '! echo A \\\n; fi'],
    ['time', 'time echo A \\\n; fi'],
    ['heredoc', 'cat <<E; fi\nbody\nE'],
  ])('points a %s node back into the line as typed', (_label, command) => {
    const root = parser.parse(command)
    const names: TSNodeLike[] = []
    const stack: TSNodeLike[] = [root]
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
      stack.push(...node.children)
      if (node.type === 'command_name' && node.text === 'fi') names.push(node)
    }
    expect(names).toHaveLength(1)
    const offsets = parser.sourceOffsets(command, root)
    expect(offsets[names[0]?.startIndex ?? -1]).toBe(command.lastIndexOf('fi'))
  })
})

describe('joinContinuations', () => {
  it.each([
    // An odd-length trailing run ends in a live continuation.
    ['echo a\\', 'echo a'],
    ['echo a\\\\\\', 'echo a\\\\'],
    ['echo \\', 'echo '],
    // An even-length run is all escaped backslashes, so nothing goes.
    ['echo a\\\\', 'echo a\\\\'],
    ['echo a\\\\\\\\', 'echo a\\\\\\\\'],
    ['echo a', 'echo a'],
    ['echo a\\ b', 'echo a\\ b'],
    // Mid-line, the pair goes wherever the reader sees it.
    ['echo a\\\nb', 'echo ab'],
    ['echo "a\\\nb"', 'echo "ab"'],
    ['echo $\\\n{x} $((1\\\n+2))', 'echo ${x} $((1+2))'],
    ['ec\\\nho a', 'echo a'],
    ['echo a\\\\\nb', 'echo a\\\\\nb'],
    ['echo a\\\\\\\nb', 'echo a\\\\b'],
    // Single-quoted and ANSI-C text and comments keep theirs.
    ["echo 'a\\\nb'", "echo 'a\\\nb'"],
    ["echo $'a\\\nb'", "echo $'a\\\nb'"],
    ['echo a # c \\\necho b', 'echo a # c \\\necho b'],
    ['echo "$(echo \'u\\\nv\')"', 'echo "$(echo \'u\\\nv\')"'],
    ['echo "it\'s a\\\nb"', 'echo "it\'s ab"'],
  ])('%j -> %j', (command, expected) => {
    expect(joinContinuations(rawParser, command)).toBe(expected)
  })

  it('keeps a quoted heredoc body whole', () => {
    const root = parser.parse("cat <<'E' | \\\ntr a b\na\\\nb\nE")
    expect(root.text).toBe('cat <"a\\\\\nb\n" | tr a b\n')
    expect(root.sourceText).toBe("cat <<'E' | \\\ntr a b\na\\\nb\nE")
  })

  it('joins an unquoted heredoc body', () => {
    expect(parser.parse('cat <<E | \\\ntr a b\na\\\nb $x\nE').text).toBe(
      'cat <"ab $x\n" | tr a b\n',
    )
  })
})

it('keeps source rows across a newline shielded inside an extended pattern', () => {
  const root = parser.parse('echo @(😀\nb|c)\necho after')
  const [first, second] = root.namedChildren
  expect(first?.text).toBe('echo @(😀\nb|c)')
  expect(first?.endPosition).toEqual({ row: 1, column: 4 })
  expect(second?.startPosition).toEqual({ row: 2, column: 0 })
  expect(second?.text).toBe('echo after')
})
