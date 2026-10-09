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
import { assert, beforeAll, describe, expect, it } from 'vitest'
import { decodeText } from '../bytes.ts'
import { checkSyntax, createShellParser, syntaxErrorResult, type ShellParser } from './index.ts'
import { MAX_NESTING } from './constants.ts'
import { heredocPlan } from './syntax.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let parser: ShellParser

beforeAll(async () => {
  parser = await createShellParser({ engineWasm, grammarWasm })
})

const CORPUS = (
  JSON.parse(
    readFileSync(
      new URL('../../../../../../integ/fixtures/shell/bash_syntax.json', import.meta.url),
      'utf8',
    ),
  ) as { lines: { line: string; status: number; stderr: string }[] }
).lines

const encode = (text: string): number[] => [...new TextEncoder().encode(text)]

describe('checkSyntax', () => {
  it('reads every line as bash reads it', () => {
    // integ/fixtures/shell/bash_syntax.json is pinned against bash by
    // scripts/pin_bash_syntax.py, which also fuzzes the reader against it;
    // the python suite (tests/shell/parse/test_syntax.py) reads the same rows.
    const differ = CORPUS.filter((row) => {
      const found = checkSyntax(row.line)
      return found === null
        ? row.status !== 0
        : found.status !== row.status || found.message !== row.stderr
    })
    expect(differ.map((row) => row.line)).toEqual([])
  })

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
  ])('keeps an invalid byte as typed in %j', async (raw, stderr) => {
    const line = decodeText(new Uint8Array(raw))
    const found = checkSyntax(line)
    assert(found)
    expect(Array.from(await syntaxErrorResult(found).materializeStderr())).toEqual(stderr)
  })

  it('refuses a line nested past the reader at the next opener', () => {
    // bash refuses a line nested past its own reader at the opener it can no
    // longer take (thousands deep there), so nothing on the line runs.
    const deep = `echo ${'$(echo '.repeat(4096)}x${')'.repeat(4096)}; fi`
    expect(checkSyntax(deep)?.offending).toBe('$(')
    const braces = (n: number) => `${'{ '.repeat(n)}a; ${'} '.repeat(MAX_NESTING)}`
    expect(checkSyntax(braces(MAX_NESTING))).toBeNull()
    expect(checkSyntax(braces(MAX_NESTING + 1))?.offending).toBe('{')
    const bangs = `[[ ${'! '.repeat(200_000)}x ]]`
    expect(checkSyntax(bangs)).toEqual({
      offending: '',
      message: 'mirage: syntax error: nesting too deep\n',
      status: 2,
    })
    expect(heredocPlan(bangs)).toBeNull()
    const own = (): boolean => {
      throw new RangeError('Invalid array length')
    }
    expect(() => checkSyntax('echo F; fi', new Set(['fi']), own)).toThrow('Invalid array length')
  })

  it('reads a substitution once however often its word is', () => {
    expect(checkSyntax(`${'x=$('.repeat(40)}echo hi${')'.repeat(40)}`)).toBeNull()
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
    expect(checkSyntax(cmd, new Set([alias]))?.offending ?? null).toBe(word)
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
    expect(
      checkSyntax(line, new Set(own.keys()), (name, at) => {
        const span = own.get(name)
        return span !== undefined && span[0] <= at && at < span[1]
      })?.offending ?? null,
    ).toBe(word)
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
