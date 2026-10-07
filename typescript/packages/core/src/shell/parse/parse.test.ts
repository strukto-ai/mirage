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
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { getParts, getRedirects, getText } from '../helpers.ts'
import { createShellParser, type ShellParser } from './index.ts'
import { NodeType as NT, type TSNodeLike } from '../types.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let parser: ShellParser

beforeAll(async () => {
  parser = await createShellParser({ engineWasm, grammarWasm })
})

describe('createShellParser', () => {
  it('parses a simple command to a program root with a command child', () => {
    const root = parser.parse('echo hello')
    expect(root.type).toBe('program')
    expect(root.childCount).toBeGreaterThan(0)
    const command = root.child(0)
    expect(command?.type).toBe('command')
  })

  it('parses a pipeline to a program with a pipeline child', () => {
    const root = parser.parse('echo hello | grep world')
    expect(root.type).toBe('program')
    const pipeline = root.child(0)
    expect(pipeline?.type).toBe('pipeline')
  })

  it('parses a redirection', () => {
    const root = parser.parse('echo hi > /tmp/x.txt')
    expect(root.type).toBe('program')
    const stmt = root.child(0)
    expect(stmt?.type).toBe('redirected_statement')
  })

  it('exposes node text matching the source', () => {
    const root = parser.parse('cat /data/foo.txt')
    const command = root.child(0)
    expect(command?.text).toBe('cat /data/foo.txt')
  })

  it('returns the same parser interface across multiple parse() calls', () => {
    const a = parser.parse('ls')
    const b = parser.parse('pwd')
    expect(a.type).toBe('program')
    expect(b.type).toBe('program')
    expect(a.child(0)?.text).toBe('ls')
    expect(b.child(0)?.text).toBe('pwd')
  })
})

describe('createShellParser — realistic multi-statement command', () => {
  // Mirrors a command run by a user against an R2 mount that surfaced an
  // OPFS getFileHandle error. We don't dispatch here — we just verify the
  // parser tokenizes the command into exactly the structure we expect, so a
  // future regression in shell parsing can't quietly reroute grep elsewhere.
  const SRC =
    "find /r2/Review -maxdepth 3 -type f | sed 's#^#FILE #'; echo '---'; grep -RIl \"Base3\\|base3\" /r2/Review || true"

  it('produces a program with three top-level statements', () => {
    const root = parser.parse(SRC)
    expect(root.type).toBe('program')
    expect(root.namedChildren).toHaveLength(3)
  })

  it('first statement is a pipeline of find | sed', () => {
    const root = parser.parse(SRC)
    const first = root.namedChildren[0]
    expect(first?.type).toBe('pipeline')
    const cmds = first?.namedChildren.filter((n) => n.type === 'command') ?? []
    expect(cmds).toHaveLength(2)
    expect(cmds[0]?.text.startsWith('find /r2/Review')).toBe(true)
    expect(cmds[1]?.text.startsWith('sed ')).toBe(true)
  })

  it('second statement is echo with a single-quoted arg', () => {
    const root = parser.parse(SRC)
    const second = root.namedChildren[1]
    expect(second?.type).toBe('command')
    expect(second?.text).toBe("echo '---'")
  })

  it('third statement is grep || true', () => {
    const root = parser.parse(SRC)
    const third = root.namedChildren[2]
    expect(third?.type).toBe('list')
    const left = third?.namedChildren[0]
    expect(left?.type).toBe('command')
    expect(left?.text.startsWith('grep ')).toBe(true)
    expect(third?.text.includes('|| true')).toBe(true)
  })

  it('quoted regex "Base3\\|base3" stays a single argument', () => {
    const root = parser.parse(SRC)
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
    const root = parser.parse(SRC)
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
    const root = parser.parse(command)
    expect(root.hasError).toBe(false)
    expect(root.sourceText).toBe(command)
    expect(root.namedChildren[0]?.namedChildren.at(-1)?.heredoc?.body).toBe(body)
  })

  it('exposes expansions as ordinary string children', () => {
    const root = parser.parse('cat <<EOF\n\\a $v `echo body`\nEOF')
    const word = root.namedChildren[0]?.namedChildren.at(-1)?.namedChildren.at(-1)
    expect(word?.namedChildren.map((child) => child.type)).toContain(NT.SIMPLE_EXPANSION)
    expect(word?.namedChildren.map((child) => child.type)).toContain(NT.COMMAND_SUBSTITUTION)
  })

  it('keeps escaped dollars literal', () => {
    const root = parser.parse('cat <<EOF\n\\$v\nEOF')
    const word = root.namedChildren[0]?.namedChildren.at(-1)?.namedChildren.at(-1)
    expect(word?.namedChildren.map((child) => child.type)).not.toContain(NT.SIMPLE_EXPANSION)
  })

  it('keeps the pipeline outside the body', () => {
    const root = parser.parse("cat <<'EOF' | tr a-z A-Z\n\\first\nEOF")
    expect(root.namedChildren[0]?.type).toBe(NT.PIPELINE)
    expect(root.namedChildren[0]?.namedChildren.at(-1)?.text).toBe('tr a-z A-Z')
  })
})

describe('heredoc source reader: operator-line regressions', () => {
  function bodiesByDelimiter(command: string): Record<string, string> {
    const root = parser.parse(command)
    expect(root.hasError).toBe(false)
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
    const root = parser.parse(command)
    expect(root.hasError).toBe(false)
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
    // `EOF;` is tree-sitter's token and a body line at once, so the typed
    // source parses clean with a body one line short; bash's word is EOF.
    expect(bodiesByDelimiter('cat <<EOF; echo x\nhi\nEOF;\nEOF\n')).toEqual({ EOF: 'hi\nEOF;\n' })
    expect(bodiesByDelimiter('cat <<EOF|tr a-z A-Z\nhi\nEOF|tr a-z A-Z\nEOF\n')).toEqual({
      EOF: 'hi\nEOF|tr a-z A-Z\n',
    })
  })

  it('keeps a body line that only opens with the delimiter', () => {
    // tree-sitter-bash's scanner compares a line's first characters with
    // the delimiter and stops there; bash wants the whole line.
    expect(bodiesByDelimiter('cat <<EOF\nEOFX\nEOF;\n EOF\nEOF\n')).toEqual({
      EOF: 'EOFX\nEOF;\n EOF\n',
    })
    expect(bodiesByDelimiter('cat <<-EOF\n\thi\n\tEOFX\n  EOF\n\tEOF\n')).toEqual({
      EOF: 'hi\nEOFX\n  EOF\n',
    })
  })

  it('leaves an unterminated body as typed', () => {
    const root = parser.parse('cat <<EOF; echo x\nhi\n')
    expect(root.hasError).toBe(false)
    expect(root.sourceText).toBe('cat <<EOF; echo x\nhi\n')
    expect(root.warnings).not.toBe('')
  })
})

describe('an operator token where bash reads a word', () => {
  // tree-sitter-bash takes `==`/`=~` there for a `[`-style operator that
  // wants an operand, so `echo ==` failed and `echo == x` lost the word.
  it.each([
    ['echo ==', ['echo', '==']],
    ['echo == x', ['echo', '==', 'x']],
    ['echo a =~ b', ['echo', 'a', '=~', 'b']],
    ['echo =~ a.b*', ['echo', '=~', 'a.b*']],
    ['test a == a', ['test', 'a', '==', 'a']],
    ['echo =="x"', ['echo', '=="x"']],
  ])('reads %j as words', (line, words) => {
    const root = parser.parse(line)
    expect(root.hasError).toBe(false)
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
    expect(parser.parse(line).hasError).toBe(false)
  })

  it('keeps a redirect after an operator word a redirect', () => {
    // The operand the grammar wanted after `==` swallowed `>/dev/null`.
    const [command, redirects] = getRedirects(
      parser.parse('echo == >/dev/null').namedChildren[0] as TSNodeLike,
    )
    if (command === null) throw new Error('expected the redirected command')
    expect(getParts(command).map((p) => getText(p))).toEqual(['echo', '=='])
    expect(redirects.map((r) => r.target)).toEqual(['/dev/null'])
  })

  it('keeps the translation marker with its string', () => {
    const command = parser.parse('echo $"hello"').namedChildren[0] as TSNodeLike
    expect(getParts(command).map((p) => getText(p))).toEqual(['echo', '"hello"'])
  })

  it.each([
    ['[[ a == b ]]', '=='],
    ['[ a =~ b ]', '=~'],
    ['(( 1 == 1 ))', '=='],
  ])('keeps the operator inside %j an operator', (line, operator) => {
    const expression = parser.parse(line).namedChildren[0]?.namedChildren[0]
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
    const root = parser.parse(line)
    expect(root.hasError).toBe(false)
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
    const root = parser.parse(line)
    expect(nodesOf(root, NT.TEST_COMMAND).length).toBeGreaterThan(0)
    const heads = nodesOf(root, NT.COMMAND).map((c) => getParts(c).map((p) => getText(p))[0])
    expect(heads).not.toContain('[')
  })
})
