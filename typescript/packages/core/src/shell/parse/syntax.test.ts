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
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { decodeText } from '../bytes.ts'
import {
  createShellParser,
  findSyntaxError,
  findUnterminatedBacktick,
  type ShellParser,
} from './index.ts'
import { endsInsideConstruct, failsInArray, findSyntaxIssue, syntaxErrorResult } from './syntax.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let parser: ShellParser

beforeAll(async () => {
  parser = await createShellParser({ engineWasm, grammarWasm })
})

describe('endsInsideConstruct', () => {
  it.each([
    ['if true', true],
    ['case x', true],
    ['f() {', true],
    ['( ( echo a', true],
    ['echo a |', true],
    ['if true; then echo a; else', true],
    ['case x in a) echo', true],
    ['if then', false],
    ['if ;', false],
    ['if }', false],
    ['echo x (', false],
    ['( then', false],
    ['if true; then else', false],
    ['for i in 1; do ;', false],
    [') ; if true; then', false],
    ['; if true; then', false],
    ['while ) ; do', false],
    ['echo a ) ; if true; then', false],
    ['echo a | ; if true; then', false],
    ['f() ; if true; then', false],
    ['echo a\n; while true; do', false],
    ['case x in a', false],
    ['case x in a) echo;; b', false],
  ])('%s: %s', (line, unfinished) => {
    expect(endsInsideConstruct(parser.parse(line))).toBe(unfinished)
  })

  it('takes an alias spelling a closer as a command at the end', () => {
    const root = parser.parse('fi; echo a |')
    expect(endsInsideConstruct(root)).toBe(false)
    expect(endsInsideConstruct(root, new Set(['fi']))).toBe(true)
    // Inside its own text an alias is the reserved word again.
    const own = parser.parse('if fi; echo a')
    expect(endsInsideConstruct(own, new Set(['fi']))).toBe(true)
    expect(endsInsideConstruct(own, new Set(['fi']), new Map([['fi', [0, 5]]]))).toBe(false)
  })
})

describe('the first error read', () => {
  it.each([
    ['fi; x=(1 2', "mirage: syntax error near 'fi'\n", 2],
    ['fi; echo "abc', "mirage: syntax error near 'fi'\n", 2],
    ['if then; x=(1 2', "mirage: syntax error near 'then'\n", 2],
    ['if true; then x+=(1 2', "mirage: unexpected EOF while looking for matching `)'\n", 1],
    ['x=(1 2; fi', "mirage: syntax error near ';'\n", 1],
    ['x=(1 2 | cat', "mirage: syntax error near '|'\n", 1],
    ['x=(1 2 >f', "mirage: syntax error near '>'\n", 1],
  ])('%s is the one reported', async (line, message, status) => {
    const root = parser.parse(line)
    const issue = findSyntaxIssue(root)
    expect(issue).not.toBeNull()
    if (issue === null) return
    const io = syntaxErrorResult(
      issue.offending,
      root,
      new Set(),
      new Map(),
      undefined,
      issue.span.end,
    )
    expect([new TextDecoder().decode(await io.materializeStderr()), io.exitCode]).toEqual([
      message,
      status,
    ])
  })
})

describe('failsInArray', () => {
  it.each([
    ['x=(1 2', true],
    ['x=(1 $(echo', true],
    ['x=(1 "a', true],
    ['if true; then x=(1 2', true],
    ['x=(1 2) ; y=(', true],
    ['x=(1 2; fi', true],
    ['echo $(x=(1 2)', false],
    ['x=(1 (2', false],
    ['echo $(echo', false],
    ['x=(1 2)', false],
  ])('%s: %s', (line, inside) => {
    const root = parser.parse(line)
    expect(failsInArray(root)).toBe(inside)
    if (inside) expect(syntaxErrorResult(line, root).exitCode).toBe(1)
  })
})

describe('syntaxErrorResult', () => {
  it('keeps an invalid byte in the span as typed', async () => {
    const line = decodeText(new Uint8Array([0x5b, 0x5b, 0x20, 0x27, 0xff, 0x27]))
    const io = syntaxErrorResult(line, parser.parse(line))
    expect(io.exitCode).toBe(2)
    expect(Array.from(await io.materializeStderr())).toEqual([
      ...new TextEncoder().encode("mirage: syntax error near '[[ '"),
      0xff,
      ...new TextEncoder().encode("''\n"),
    ])
  })
})

describe('findSyntaxError', () => {
  it('reports syntax errors after deeply nested command substitutions', () => {
    const depth = 4096
    const root = parser.parse(`echo ${'$(echo '.repeat(depth)}x${')'.repeat(depth)} (`)
    expect(findSyntaxError(root)).toBe('(')
  })

  it.each([
    'if then fi',
    'echo (',
    'for x do done',
    'for',
    'if',
    'if; fi',
    'echo "unterm',
    ';s',
    '| s',
    '&& s',
    '& s',
    'echo a ; ; echo b',
    'echo bg &; echo fg',
    'true;;s',
    'echo a ;& echo b',
  ])('flags structural syntax error in %j', (cmd) => {
    const root = parser.parse(cmd)
    expect(findSyntaxError(root)).not.toBeNull()
  })

  it.each([
    'echo hi',
    'for x in a b; do echo $x; done',
    'if true; then echo y; fi',
    'cat /tmp/x | sort',
    "cat <<EN'D'\n$v\nEND",
    'echo bg & echo fg',
    'echo a &',
    'echo a;',
    'case x in a) echo a;; esac',
    'case x in a) echo a;& b) echo b;;& c) echo c;; esac',
    'for x in; do echo $x; done',
  ])('returns null for valid / recoverable %j', (cmd) => {
    const root = parser.parse(cmd)
    expect(findSyntaxError(root)).toBeNull()
  })

  it.each([
    [';s', ';'],
    ['| s', '|'],
    ['&& s', '&&'],
    ['echo a ; ; echo b', ';'],
    ['echo bg &; echo fg', ';'],
    ['true;;s', ';;'],
  ])('names the stray separator in %j', (cmd, token) => {
    const root = parser.parse(cmd)
    expect(findSyntaxError(root)?.trim()).toBe(token)
  })
})

describe('a reserved word where a command starts', () => {
  // Pinned against bash 5.2.37, which refuses the line at the word.
  it.each([
    ['echo hi; fi', 'fi'],
    ['done', 'done'],
    ['then', 'then'],
    ['esac', 'esac'],
    ['}', '}'],
    [']]', ']]'],
    ['in', 'in'],
    ['! fi', 'fi'],
    ['fi >/dev/null', 'fi'],
    ['echo a | fi', 'fi'],
    ['echo a && fi', 'fi'],
    ['fi; done', 'fi'],
    ['fi; for a in b; do done', 'fi'],
    ['if x; then fi; for a in b; do done', 'fi'],
  ])('names %j a syntax error at %j', (cmd, word) => {
    expect(findSyntaxError(parser.parse(cmd))).toBe(word)
  })

  it.each([
    '"fi"',
    '\\fi',
    'x=1 fi',
    '>/dev/null fi',
    'echo fi done then',
    'if true; then echo y; fi',
    'for x in a; do echo $x; done',
    '{ echo a; }',
    'case a in a) echo m;; esac',
  ])('reads the word in %j as a word', (cmd) => {
    expect(findSyntaxError(parser.parse(cmd))).toBeNull()
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
    const parse = (source: string) => parser.parse(source)
    expect(findSyntaxError(parser.parse(cmd), parse, new Set([alias]))).toBe(word)
  })

  // Pinned against bash 5.2.37: a name stays reserved only inside the text its
  // alias put there, a trailing blank's chained one included.
  const OWN: [string, [string, number, number][], string | null][] = [
    ['echo F; fi', [['fi', 0, 10]], 'fi'],
    ['echo F; fi', [['fi', 0, 7]], null],
    [
      'echo C; fi echo F',
      [
        ['c', 0, 11],
        ['fi', 11, 17],
      ],
      null,
    ],
    [
      'echo C; echo F; fi',
      [
        ['c', 0, 8],
        ['fi', 8, 18],
      ],
      'fi',
    ],
    ['echo F \\\n; fi', [['fi', 0, 13]], 'fi'],
    ['echo F \\\n; fi', [['fi', 0, 10]], null],
  ]
  it.each(OWN)('reads %j with alias text %j as %j', (line, spans, word) => {
    const own = new Map(spans.map(([name, start, end]) => [name, [start, end] as const]))
    const root = parser.parse(line)
    const offsets = parser.sourceOffsets(line, root)
    expect(findSyntaxError(root, undefined, new Set(own.keys()), own, offsets)).toBe(word)
  })
})

describe('findUnterminatedBacktick', () => {
  it.each(['echo `echo a', 'echo "`echo \'`\'`"', 'echo a`', '`'])(
    'flags the open region in %j',
    (command) => {
      expect(findUnterminatedBacktick(command)).not.toBeNull()
    },
  )

  it.each([
    'echo `echo a`',
    'echo `echo a` `echo b`',
    // Single quotes protect a backtick, double quotes do not.
    "echo '`'",
    'echo "`echo a`"',
    'echo "\\`"',
    // Only a backslash escapes inside the region.
    'echo `echo \\`nested\\``',
    'echo a',
    'cat <<EOF\nplain\nEOF',
  ])('accepts balanced %j', (command) => {
    expect(findUnterminatedBacktick(command)).toBeNull()
  })
})

const missingQuoteCases = JSON.parse(
  readFileSync(
    new URL('../../../../../../integ/bash/syntax/quoting.json', import.meta.url),
    'utf8',
  ),
) as { cases: { command: string; expect: { exit: number } }[] }
it.each(missingQuoteCases.cases.filter((c) => c.expect.exit === 2).map((c) => c.command))(
  'missing nested quote refuses before any execution: %s',
  async (command) => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { shellParser: parser })
    try {
      const io = await ws.shell(command)
      expect(io.exitCode).toBe(2)
      expect(new TextDecoder().decode(io.stdout)).toBe('')
      expect(new TextDecoder().decode(io.stderr)).toContain(
        'unexpected EOF while looking for matching',
      )
      expect((await ws.shell('test -e /data/unexpected')).exitCode).toBe(1)
    } finally {
      await ws.close()
    }
  },
)

it.each([
  ['echo "it\'s fine"', "it's fine\n"],
  ['echo ok # unterminated \'"', 'ok\n'],
  ["cat <<'EOF'\n'\"\nEOF", '\'"\n'],
  ["echo $'closed\\''", "closed'\n"],
])('literal quotes are not unclosed: %s', async (command, expected) => {
  const ws = new Workspace({ '/data': new RAMVFS() }, { shellParser: parser })
  try {
    const io = await ws.shell(command)
    expect(io.exitCode).toBe(0)
    expect(new TextDecoder().decode(io.stdout)).toBe(expected)
    expect(new TextDecoder().decode(io.stderr)).toBe('')
  } finally {
    await ws.close()
  }
})
