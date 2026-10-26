import { describe, expect, it } from 'vitest'
import type { TSNodeLike } from '../types.ts'
import { joinContinuations, sourceOffsets } from './index.ts'
import { parse } from './parse.ts'

describe('sourceOffsets', () => {
  it.each([
    ['continuation', 'echo A; \\\n fi'],
    ['expansion', 'echo /api/$c/$id.json; fi'],
    ['bang', '! echo A \\\n; fi'],
    ['time', 'time echo A \\\n; fi'],
    ['heredoc', 'cat <<E; fi\nbody\nE'],
  ])('points a %s node back into the line as typed', (_label, command) => {
    // The stray `fi` is where the parser refuses each line.
    const root = parse(command)
    const errors = root.children.filter((node) => node.type === 'ERROR')
    expect(errors).toHaveLength(1)
    const offsets = sourceOffsets(command, root)
    expect(offsets[errors[0]?.startIndex ?? -1]).toBe(command.lastIndexOf('fi'))
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
    expect(joinContinuations(command)).toBe(expected)
  })

  it('keeps a quoted heredoc body whole', () => {
    const root = parse("cat <<'E' | \\\ntr a b\na\\\nb\nE")
    expect(root.text).toBe('cat <"a\\\\\nb\n" | tr a b\n')
    expect(root.sourceText).toBe("cat <<'E' | \\\ntr a b\na\\\nb\nE")
  })

  it('joins an unquoted heredoc body', () => {
    expect(parse('cat <<E | \\\ntr a b\na\\\nb $x\nE').text).toBe('cat <"ab $x\n" | tr a b\n')
  })
})

it('keeps source rows across a newline shielded inside an extended pattern', () => {
  const root = parse('echo @(😀\nb|c)\necho after')
  const [first, second] = root.namedChildren
  expect(first?.text).toBe('echo @(😀\nb|c)')
  expect(first?.endPosition).toEqual({ row: 1, column: 4 })
  expect(second?.startPosition).toEqual({ row: 2, column: 0 })
  expect(second?.text).toBe('echo after')
})

it('preserves pattern source rows across a long script', () => {
  const root = parse('echo @(😀\nb|c)\n'.repeat(1000) + 'echo end')
  const statements = root.namedChildren
  expect(statements).toHaveLength(1001)
  for (const index of [0, 500, 999]) {
    expect(statements[index]?.startPosition).toEqual({ row: 2 * index, column: 0 })
    expect(statements[index]?.endPosition).toEqual({ row: 2 * index + 1, column: 4 })
  }
  expect(statements.at(-1)?.startPosition).toEqual({ row: 2000, column: 0 })
})

it('does not consume later commands for heredoc tokens inside patterns', () => {
  const root = parse('echo @(a<<b|c)\ncat <<EOF\nbody\nEOF\necho after\n')
  expect(root.namedChildren).toHaveLength(3)
  expect(root.namedChildren[0]?.text).toBe('echo @(a<<b|c)')
  expect(root.namedChildren.at(-1)?.text).toBe('echo after')
})

it.each(['[[ @ == [a"@"] ]]', '[[ $x == [a"$x"] ]]', 'case "$x" in [a"$x"]) echo match;; esac'])(
  'keeps a quoted bracket pattern one operand: %s',
  (command) => {
    const root = parse(command)
    expect(root.hasError).toBe(false)
    expect(root.text).toBe(command)
    const stack: TSNodeLike[] = [root]
    const strings: string[] = []
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
      stack.push(...node.namedChildren)
      if (node.type === 'string') strings.push(node.text)
    }
    expect(strings.length).toBeGreaterThan(0)
    expect(strings.every((value) => ['"@"', '"$x"'].includes(value))).toBe(true)
  },
)

it('keeps process substitution in one extended-pattern word', () => {
  const command = parse('echo @(<(printf a)|b)').namedChildren[0]
  expect(command?.namedChildren).toHaveLength(2)
  const word = command?.namedChildren[1]
  expect(word?.type).toBe('concatenation')
  const sub = word?.namedChildren.find((child) => child.type === 'process_substitution')
  expect(sub?.text).toBe('<(printf a)')
  expect(sub?.children[0]?.type).toBe('<(')
})
