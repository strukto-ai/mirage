// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { decodeText, encodeText } from '../bytes.ts'
import { endsEscaped } from '../escapes.ts'
import { getParts, getRedirects, getText } from '../helpers.ts'
import { NodeType as NT, type TSNodeLike } from '../types.ts'
import { parse, syntaxRefusal } from './parse.ts'

const CORPUS = (
  JSON.parse(
    readFileSync(
      new URL('../../../../../../integ/fixtures/shell/bash_syntax.json', import.meta.url),
      'utf8',
    ),
  ) as { lines: { line: string; status: number; stderr: string }[] }
).lines

// Rows of bash_syntax.json, pinned with `bash -c`, that mirage reads
// otherwise. Mirrors Python's DIVERGES.
const DIVERGES = new Set([
  'cat <<EOF\n$(\nEOF',
  'cat <<EOF\n$(fi)\nEOF',
  'cat <<EOF\n${a\nEOF',
  'cat <<EOF\n`\nEOF',
  'declare a[x y]=(1)',
  'f() x=({\necho\n}',
  '{fd}>f x=(a[)',
])

const refusal = (line: string, aliases: ReadonlySet<string> = new Set()): [number, string] => {
  const io = syntaxRefusal(parse(line, aliases, false))
  return io === null ? [0, ''] : [io.exitCode, decodeText(io.stderr as Uint8Array)]
}

describe('parse', () => {
  it('parses a simple command to a program root with a command child', () => {
    const root = parse('echo hello')
    expect(root.type).toBe('program')
    expect(root.childCount).toBeGreaterThan(0)
    const command = root.child(0)
    expect(command?.type).toBe('command')
  })

  it('parses a pipeline to a program with a pipeline child', () => {
    const root = parse('echo hello | grep world')
    expect(root.type).toBe('program')
    const pipeline = root.child(0)
    expect(pipeline?.type).toBe('pipeline')
  })

  it('parses a redirection', () => {
    const root = parse('echo hi > /tmp/x.txt')
    expect(root.type).toBe('program')
    const stmt = root.child(0)
    expect(stmt?.type).toBe('redirected_statement')
  })

  it('exposes node text matching the source', () => {
    const root = parse('cat /data/foo.txt')
    const command = root.child(0)
    expect(command?.text).toBe('cat /data/foo.txt')
  })

  it('returns the same parser interface across multiple parse() calls', () => {
    const a = parse('ls')
    const b = parse('pwd')
    expect(a.type).toBe('program')
    expect(b.type).toBe('program')
    expect(a.child(0)?.text).toBe('ls')
    expect(b.child(0)?.text).toBe('pwd')
  })
})

describe('parse — realistic multi-statement command', () => {
  // Mirrors a command run by a user against an R2 mount that surfaced an
  // OPFS getFileHandle error. We don't dispatch here — we just verify the
  // parser tokenizes the command into exactly the structure we expect, so a
  // future regression in shell parsing can't quietly reroute grep elsewhere.
  const SRC =
    "find /r2/Review -maxdepth 3 -type f | sed 's#^#FILE #'; echo '---'; grep -RIl \"Base3\\|base3\" /r2/Review || true"

  it('produces a program with three top-level statements', () => {
    const root = parse(SRC)
    expect(root.type).toBe('program')
    expect(root.namedChildren).toHaveLength(3)
  })

  it('first statement is a pipeline of find | sed', () => {
    const root = parse(SRC)
    const first = root.namedChildren[0]
    expect(first?.type).toBe('pipeline')
    const cmds = first?.namedChildren.filter((n) => n.type === 'command') ?? []
    expect(cmds).toHaveLength(2)
    expect(cmds[0]?.text.startsWith('find /r2/Review')).toBe(true)
    expect(cmds[1]?.text.startsWith('sed ')).toBe(true)
  })

  it('second statement is echo with a single-quoted arg', () => {
    const root = parse(SRC)
    const second = root.namedChildren[1]
    expect(second?.type).toBe('command')
    expect(second?.text).toBe("echo '---'")
  })

  it('third statement is grep || true', () => {
    const root = parse(SRC)
    const third = root.namedChildren[2]
    expect(third?.type).toBe('list')
    const left = third?.namedChildren[0]
    expect(left?.type).toBe('command')
    expect(left?.text.startsWith('grep ')).toBe(true)
    expect(third?.text.includes('|| true')).toBe(true)
  })

  it('quoted regex "Base3\\|base3" stays a single argument', () => {
    const root = parse(SRC)
    const third = root.namedChildren[2]
    const grepCmd = third?.namedChildren[0]
    expect(grepCmd?.type).toBe('command')
    // collect argv-style children: (name) + word-like args
    const args = grepCmd?.namedChildren ?? []
    const argTexts = args.map((n) => n.text)
    // Expect the regex appears as one element (with its surrounding quotes).
    const regexArg = argTexts.find((t) => t.includes('Base3'))
    expect(regexArg).toBe('"Base3\\|base3"')
  })

  it('grep target path /r2/Review parses as a single argument, no glob expansion at parse time', () => {
    const root = parse(SRC)
    const third = root.namedChildren[2]
    const grepCmd = third?.namedChildren[0]
    const args = grepCmd?.namedChildren ?? []
    const argTexts = args.map((n) => n.text)
    const pathArg = argTexts.find((t) => t === '/r2/Review')
    expect(pathArg).toBe('/r2/Review')
  })
})

describe('heredoc source reader', () => {
  it.each([
    ["cat <<'EOF'\n\\first\nsecond\nEOF", '\\first\nsecond\n'],
    ["cat <<'EOF'\n\\first\n\\second\nthird\nEOF", '\\first\n\\second\nthird\n'],
    ["cat <<'EOF'\n  first\nsecond\nEOF", '  first\nsecond\n'],
    ["cat <<'EOF'\n\\begin{table}\n  \\begin{center}\nEOF", '\\begin{table}\n  \\begin{center}\n'],
    ["cat <<'EOF'\n\\item Don't\nsecond\nEOF", "\\item Don't\nsecond\n"],
    ['cat <<"E\\$F"\n\\first\nE$F', '\\first\n'],
  ])('preserves body and source: %s', (command, body) => {
    const root = parse(command)
    expect(root.error).toBeNull()
    expect(root.sourceText).toBe(command)
    expect(root.namedChildren[0]?.namedChildren.at(-1)?.heredoc?.body).toBe(body)
  })

  it('exposes expansions as ordinary string children', () => {
    const root = parse('cat <<EOF\n\\a $v `echo body`\nEOF')
    const word = root.namedChildren[0]?.namedChildren.at(-1)?.namedChildren.at(-1)
    expect(word?.namedChildren.map((child) => child.type)).toContain(NT.SIMPLE_EXPANSION)
    expect(word?.namedChildren.map((child) => child.type)).toContain(NT.COMMAND_SUBSTITUTION)
  })

  it('keeps escaped dollars literal', () => {
    const root = parse('cat <<EOF\n\\$v\nEOF')
    const word = root.namedChildren[0]?.namedChildren.at(-1)?.namedChildren.at(-1)
    expect(word?.namedChildren.map((child) => child.type)).not.toContain(NT.SIMPLE_EXPANSION)
  })

  it('keeps the pipeline outside the body', () => {
    const root = parse("cat <<'EOF' | tr a-z A-Z\n\\first\nEOF")
    expect(root.namedChildren[0]?.type).toBe(NT.PIPELINE)
    expect(root.namedChildren[0]?.namedChildren.at(-1)?.text).toBe('tr a-z A-Z')
  })
})

describe('heredoc source reader: operator-line regressions', () => {
  function bodiesByDelimiter(command: string): Record<string, string> {
    const root = parse(command)
    expect(root.error).toBeNull()
    const found: Record<string, string> = {}
    const stack: TSNodeLike[] = [root]
    for (;;) {
      const node = stack.pop()
      if (node === undefined) break
      stack.push(...node.children)
      if (node.heredoc !== undefined) found[node.heredoc.delimiter] = node.heredoc.body
    }
    return found
  }

  it.each([
    'cat <<EOF; echo x\nhi\nEOF\n',
    'cat <<EOF;echo x\nhi\nEOF\n',
    'cat <<EOF>out\nhi\nEOF\n',
    'cat <<EOF|wc -l\nhi\nEOF\n',
    'cat <<EOF&&echo x\nhi\nEOF\n',
    "cat <<'EOF'; echo x\nhi\nEOF\n",
    'cat <<EOF;\nhi\nEOF;\nEOF\n',
    '(cat <<EOF)\nhi\nEOF)\nEOF\n',
    'cat <<A && cat <<B\na\nA\nb\nB\n',
    'cat <<A; cat <<B\na\nA\nb\nB\n',
    '(cat <<EOF)\nhi\nEOF\n',
    'case x in x) cat <<EOF;; esac\nhi\nEOF\n',
    '{ cat <<EOF; }\nhi\nEOF\n',
  ])('preserves operator-line source: %j', (command) => {
    const root = parse(command)
    expect(root.error).toBeNull()
    expect(root.sourceText).toBe(command)
  })

  it('keeps each of two heredocs on one line its own body', () => {
    expect(bodiesByDelimiter('cat <<A && cat <<B\na\nA\nb\nB\n')).toEqual({ A: 'a\n', B: 'b\n' })
    expect(bodiesByDelimiter('cat <<A | cat <<B; cat <<C\na\nA\nb\nB\nc\nC\n')).toEqual({
      A: 'a\n',
      B: 'b\n',
      C: 'c\n',
    })
  })

  it("keeps the body's indentation under a semicolon tail", () => {
    expect(bodiesByDelimiter('cat <<EOF; echo x\n  hi\nEOF\n')).toEqual({ EOF: '  hi\n' })
  })

  it('reads a metacharacter inside a quoted delimiter as the delimiter', () => {
    expect(bodiesByDelimiter("cat <<'EOF;'\nhi\nEOF;\n")).toEqual({ 'EOF;': 'hi\n' })
  })

  it('checks the delimiter word on a clean tree', () => {
    // `EOF;` is a body line, not the delimiter: bash's word is EOF.
    expect(bodiesByDelimiter('cat <<EOF; echo x\nhi\nEOF;\nEOF\n')).toEqual({ EOF: 'hi\nEOF;\n' })
    expect(bodiesByDelimiter('cat <<EOF|tr a-z A-Z\nhi\nEOF|tr a-z A-Z\nEOF\n')).toEqual({
      EOF: 'hi\nEOF|tr a-z A-Z\n',
    })
  })

  it('keeps a body line that only opens with the delimiter', () => {
    // bash ends a body only on a line that is the delimiter whole.
    expect(bodiesByDelimiter('cat <<EOF\nEOFX\nEOF;\n EOF\nEOF\n')).toEqual({
      EOF: 'EOFX\nEOF;\n EOF\n',
    })
    expect(bodiesByDelimiter('cat <<-EOF\n\thi\n\tEOFX\n  EOF\n\tEOF\n')).toEqual({
      EOF: 'hi\nEOFX\n  EOF\n',
    })
  })

  it('reads a body of any length', () => {
    // The host reader this replaced overflowed the stack near 6,000 lines.
    const body = 'line\n'.repeat(100_000)
    expect(bodiesByDelimiter(`cat <<'EOF' > f\n${body}EOF\n`)).toEqual({ EOF: body })
  })

  it('leaves an unterminated body as typed', () => {
    const root = parse('cat <<EOF; echo x\nhi\n')
    expect(root.error).toBeNull()
    expect(root.sourceText).toBe('cat <<EOF; echo x\nhi\n')
    expect(root.warnings).not.toBe('')
  })
})

describe('an operator token where bash reads a word', () => {
  // `==` and `=~` are words outside a test: `echo ==` runs and
  // `echo == x` keeps the word.
  it.each([
    ['echo ==', ['echo', '==']],
    ['echo == x', ['echo', '==', 'x']],
    ['echo a =~ b', ['echo', 'a', '=~', 'b']],
    ['echo =~ a.b*', ['echo', '=~', 'a.b*']],
    ['test a == a', ['test', 'a', '==', 'a']],
    ['echo =="x"', ['echo', '=="x"']],
  ])('reads %j as words', (line, words) => {
    const root = parse(line)
    expect(root.error).toBeNull()
    expect(getParts(root.namedChildren[0] as TSNodeLike).map((p) => getText(p))).toEqual(words)
  })

  it.each([
    'echo ==; echo hi',
    'echo == | cat',
    'echo ==&& echo hi',
    'f() { echo ==; }',
    'case x in x) echo ==;; esac',
    'echo $; echo hi',
  ])('parses %j without a syntax error', (line) => {
    expect(parse(line).error).toBeNull()
  })

  it('keeps a redirect after an operator word a redirect', () => {
    // The operand the grammar wanted after `==` swallowed `>/dev/null`.
    const [command, redirects] = getRedirects(
      parse('echo == >/dev/null').namedChildren[0] as TSNodeLike,
    )
    if (command === null) throw new Error('expected the redirected command')
    expect(getParts(command).map((p) => getText(p))).toEqual(['echo', '=='])
    expect(redirects.map((r) => r.target)).toEqual(['/dev/null'])
  })

  it('keeps the translation marker with its string', () => {
    const command = parse('echo $"hello"').namedChildren[0] as TSNodeLike
    expect(getParts(command).map((p) => p.type)).toEqual([NT.COMMAND_NAME, NT.TRANSLATED_STRING])
  })

  it.each([
    ['[[ a == b ]]', '=='],
    ['[ a =~ b ]', '=~'],
    ['(( 1 == 1 ))', '=='],
  ])('keeps the operator inside %j an operator', (line, operator) => {
    const expression = parse(line).namedChildren[0]?.namedChildren[0]
    expect(expression?.type).toBe(NT.BINARY_EXPRESSION)
    expect(expression?.children.filter((c) => !c.isNamed).map((c) => c.type)).toEqual([operator])
  })
})

function nodesOf(node: TSNodeLike, kind: string): TSNodeLike[] {
  const found = node.type === kind ? [node] : []
  for (const child of node.namedChildren) found.push(...nodesOf(child, kind))
  return found
}

describe('a [ that bash reads as a command', () => {
  // `[` is a command to bash: its words stop at a list or pipe operator and
  // need a `]` of their own, where the grammar builds a test anyway.
  it.each([
    [
      '[ a && b ]',
      [
        ['[', 'a'],
        ['b', ']'],
      ],
    ],
    [
      '[ a | b ]',
      [
        ['[', 'a'],
        ['b', ']'],
      ],
    ],
    ['[ a ]]', [['[', 'a', ']]']]],
    ['[ a ]x', [['[', 'a', ']x']]],
    [
      '[ a; echo x',
      [
        ['[', 'a'],
        ['echo', 'x'],
      ],
    ],
    ['[ c', [['[', 'c']]],
    ['[ \\( a \\) ]', [['[', '\\(', 'a', '\\)', ']']]],
  ])('parses %j as plain commands', (line, commands) => {
    const root = parse(line)
    expect(root.error).toBeNull()
    expect(nodesOf(root, NT.COMMAND).map((c) => getParts(c).map((p) => getText(p)))).toEqual(
      commands,
    )
  })

  it.each([
    '[ a ] && [ b ]',
    '[ a -a b ]',
    '[ "a && b" ]',
    '[ a ]>/dev/null',
    '( [ a ])',
    '[ ! a ]',
  ])('keeps %j a test', (line) => {
    const root = parse(line)
    expect(nodesOf(root, NT.TEST_COMMAND).length).toBeGreaterThan(0)
    const heads = nodesOf(root, NT.COMMAND).map((c) => getParts(c).map((p) => getText(p))[0])
    expect(heads).not.toContain('[')
  })
})

function substitution(root: TSNodeLike): TSNodeLike {
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) break
    if (node.type === 'command_substitution') return node
    stack.push(...[...node.namedChildren].reverse())
  }
  throw new Error('no substitution')
}

describe('heredoc nodes', () => {
  it('restores heredoc syntax for nested evaluation', () => {
    const node = substitution(parse('echo "$(cat <<EOF\nhello\nEOF\n)"'))
    expect(node.sourceText).toContain('<<EOF')
    expect(node.text).not.toContain('<<EOF')
  })

  it('keeps reader continuation removal in nested evaluation', () => {
    const node = substitution(parse("cat <<EOF\n$(printf '%s' 'a\\\nb')\nEOF"))
    expect(node.sourceText).toBe("$(printf '%s' 'ab')")
  })

  it('keeps earlier nodes alive across subsequent parses', () => {
    const first = parse('cat <<EOF\none\nEOF')
    parse('cat <<EOF\ntwo\nEOF')
    expect(first.namedChildren[0]?.namedChildren.at(-1)?.heredoc?.body).toBe('one\n')
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
    expect(root.error).toBeNull()
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

describe('syntax refusals', () => {
  it('reads every line as bash reads it', () => {
    // integ/fixtures/shell/bash_syntax.json is pinned against bash by
    // scripts/pin_bash_syntax.py; the python suite reads the same rows. A
    // line ending in a backslash is read as a script reads it.
    const differ = CORPUS.filter(
      (row) =>
        !DIVERGES.has(row.line) &&
        !endsEscaped(row.line) &&
        refusal(row.line).join('\0') !== [row.status, row.stderr].join('\0'),
    )
    expect(differ.map((row) => row.line)).toEqual([])
  })

  const encode = (text: string): number[] => [...new TextEncoder().encode(text)]
  it.each([
    [
      [...encode('echo ('), 0xff],
      [...encode("mirage: syntax error near '"), 0xff, ...encode("'\n")],
    ],
    [
      [...encode("[[ '"), 0xff, ...encode("'")],
      [
        ...encode(
          "mirage: unexpected token `newline', conditional binary operator expected\n" +
            "mirage: syntax error near ''",
        ),
        0xff,
        ...encode("''\n"),
      ],
    ],
  ])('keeps an invalid byte as typed in %j', (raw, stderr) => {
    const [, message] = refusal(decodeText(new Uint8Array(raw)))
    expect(Array.from(encodeText(message))).toEqual(stderr)
  })

  it('refuses a line nested past the reader at the next opener', () => {
    // bash refuses a line nested past its own reader at the opener it can no
    // longer take (thousands deep there), so nothing on the line runs.
    const deep = `echo ${'$(echo '.repeat(4096)}x${')'.repeat(4096)}; fi`
    expect(refusal(deep)).toEqual([127, "mirage: syntax error near '$('\n"])
    const braces = (n: number) => `${'{ '.repeat(n)}a; ${'} '.repeat(64)}`
    expect(refusal(braces(64))).toEqual([0, ''])
    expect(refusal(braces(65))).toEqual([2, "mirage: syntax error near '{'\n"])
    const bangs = `[[ ${'! '.repeat(200_000)}x ]]`
    expect(refusal(bangs)).toEqual([2, 'mirage: syntax error: nesting too deep\n'])
  })

  it('reads a substitution once however often its word is', () => {
    expect(refusal(`${'x=$('.repeat(40)}echo hi${')'.repeat(40)}`)).toEqual([0, ''])
  })

  // Pinned against bash 5.2.37, which takes the reserved word first inside
  // `$(...)` and a process substitution.
  it.each([
    ['fi', 'fi', null],
    ['fi', 'done', 'fi'],
    ['( fi )', 'fi', null],
    ['echo `fi`', 'fi', null],
    ['echo "$(fi)"', 'fi', 'fi'],
    ['echo $( (fi) )', 'fi', 'fi'],
    ['echo <(fi)', 'fi', 'fi'],
  ])('reads %j with an alias %j as %j', (cmd, alias, word) => {
    expect(refusal(cmd, new Set([alias]))[1]).toBe(
      word === null ? '' : `mirage: syntax error near '${word}'\n`,
    )
  })
})

it.each([
  ['echo "it\'s fine"', "it's fine\n"],
  ['echo ok # unterminated \'"', 'ok\n'],
  ["cat <<'EOF'\n'\"\nEOF", '\'"\n'],
  ["echo $'closed\\''", "closed'\n"],
])('literal quotes are not unclosed: %s', async (command, expected) => {
  const ws = new Workspace({ '/data': new RAMVFS() })
  try {
    const io = await ws.shell(command)
    expect(io.exitCode).toBe(0)
    expect(new TextDecoder().decode(io.stdout)).toBe(expected)
    expect(new TextDecoder().decode(io.stderr)).toBe('')
  } finally {
    await ws.close()
  }
})

const sideEffectCommands = (
  JSON.parse(
    readFileSync(
      new URL('../../../../../../integ/bash/syntax/quoting.json', import.meta.url),
      'utf8',
    ),
  ) as { cases: { command: string }[] }
).cases
  .map((c) => c.command)
  .filter((command) => command.includes('/data/unexpected'))

it.each(sideEffectCommands)(
  'a missing quote refuses before any command runs: %s',
  async (command) => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    try {
      expect((await ws.shell(command)).exitCode).toBe(2)
      expect((await ws.shell('test -e /data/unexpected')).exitCode).toBe(1)
    } finally {
      await ws.close()
    }
  },
)
