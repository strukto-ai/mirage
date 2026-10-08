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

import { assert, describe, expect, it } from 'vitest'

import { getParts } from '../../shell/helpers.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import { innerLines, innerReadable, readWord, wordValue, type Word } from './inner_lines.ts'

// Mirrors python/tests/workspace/node/test_inner_lines.py.

function words(...texts: string[]): Word[] {
  return texts.map((t) => ({ raw: t, text: t }))
}

type Shape = ['line', string, boolean] | ['argv', string[], boolean] | ['none', null, boolean]

function shapes(head: string, args: string[]): Shape[] {
  return innerLines(head, words(...args)).map((inner) => {
    expect(innerReadable(inner)).toBe(inner.line !== null || inner.argv.length > 0)
    if (inner.line !== null) return ['line', inner.line, inner.open]
    if (inner.argv.length > 0) return ['argv', inner.argv.map(wordValue), inner.open]
    return ['none', null, inner.open]
  })
}

describe('innerLines', () => {
  it.each<[string, string[], Shape[]]>([
    // Text the runtime parses afresh.
    ['eval', ['rm', '/x', '&&', 'ls'], [['line', 'rm /x && ls', false]]],
    ['sh', ['-c', 'rm /x'], [['line', 'rm /x', false]]],
    ['bash', ['-xc', 'rm /x', 'a'], [['line', 'rm /x', false]]],
    ['mapfile', ['-C', 'rm /x', 'arr'], [['line', 'rm /x', true]]],
    // A command already split into words.
    ['command', ['-p', 'rm', '/x'], [['argv', ['rm', '/x'], false]]],
    ['exec', ['-a', 'name', 'rm', '/x'], [['argv', ['rm', '/x'], false]]],
    ['env', ['-i', '-u', 'HOME', 'A=1', 'rm', '/x'], [['argv', ['rm', '/x'], false]]],
    ['timeout', ['-s', 'KILL', '5', 'rm', '/x'], [['argv', ['rm', '/x'], false]]],
    ['nohup', ['rm', '/x'], [['argv', ['rm', '/x'], false]]],
    // bash runs the named builtin with the words as given, so
    // `builtin eval 'rm /x'` is eval's line, admitted in turn.
    ['builtin', ['eval', 'rm /x'], [['argv', ['eval', 'rm /x'], false]]],
    ['builtin', ['--', 'echo', 'hi'], [['argv', ['echo', 'hi'], false]]],
    ['builtin', [], []],
    ['nice', ['-n', '5', 'rm', '/x'], [['argv', ['rm', '/x'], false]]],
    ['time', ['-p', 'rm', '/x'], [['argv', ['rm', '/x'], false]]],
    // Operands the runtime appends: stdin items, matched paths.
    ['xargs', ['-n', '1', 'rm', '-f'], [['argv', ['rm', '-f'], true]]],
    ['xargs', [], [['argv', ['echo'], true]]],
    [
      'find',
      ['/r', '-exec', 'rm', '{}', ';', '-ok', 'cat', '{}', '+'],
      [
        ['argv', ['rm', '{}'], true],
        ['argv', ['cat', '{}'], true],
      ],
    ],
    // Lines the gate cannot read: a file, a program from stdin, an option
    // mirage refuses and a real bash takes.
    ['source', ['f.sh'], [['none', null, false]]],
    ['.', ['f.sh'], [['none', null, false]]],
    ['sh', ['f.sh'], [['none', null, false]]],
    ['bash', [], [['none', null, false]]],
    ['bash', ['--restricted', '-c', 'rm /x'], [['none', null, false]]],
    ['./run.sh', ['a'], [['none', null, false]]],
    // Nothing runs: a probe, a bare word, a usage error, an answer.
    ['command', ['-v', 'rm'], []],
    ['eval', [], []],
    ['env', ['A=1'], []],
    ['timeout', ['5'], []],
    ['bash', ['--version', '-c', 'rm /x'], []],
    ['cat', ['/x'], []],
  ])('reads the words that run other words: %s %j', (head, args, expected) => {
    expect(shapes(head, args)).toEqual(expected)
  })

  it.each<[string, string[], string | null]>([
    ['xargs', ['-n', '1', 'rm', '-f'], 'xargs: rm: No such file or directory\n'],
    ['xargs', [], 'xargs: echo: No such file or directory\n'],
    [
      'timeout',
      ['-s', 'KILL', '5', 'rm', '/x'],
      "timeout: failed to run command 'rm': No such file or directory\n",
    ],
    ['env', ['rm', '/x'], null],
    ['command', ['rm', '/x'], null],
    ['find', ['/r', '-exec', 'rm', '{}', ';'], null],
    ['eval', ['rm', '/x'], null],
  ])('leaves a miss to a builtin that looks the name up itself: %s %j', (head, args, missing) => {
    // xargs and timeout look the name up before they run it, as GNU's
    // exec does, so a name the session cannot see is theirs to report;
    // the rest hand the words back to the shell, which reports it.
    const [inner] = innerLines(head, words(...args))
    expect(inner?.missing).toBe(missing)
  })

  it('keeps what the gate could not read', () => {
    // A dynamic word rides into the inner command as itself, raw text
    // and no literal, so the inner admission still sees it as unread.
    const dynamic: Word = { raw: '"$cmd"', text: null }
    const [inner] = innerLines('timeout', [
      { raw: '5', text: '5' },
      dynamic,
      { raw: 'x', text: 'x' },
    ])
    expect(inner?.argv[0]).toBe(dynamic)
    const [line] = innerLines('eval', [
      { raw: 'rm', text: 'rm' },
      { raw: '"$p"', text: null },
    ])
    expect(line?.line).toBe('rm "$p"')
  })

  describe.each(['bash', 'sh'])('%s literal program selection', (head) => {
    it.each<[string[], string[]]>([
      [['--rcfile'], ['--version', '-c', 'rm /x']],
      [['--init-file'], ['--help', '-c', 'rm /x']],
      [['--rcfile'], ['-c', 'echo safe', '-c', 'rm /x']],
      [['-c'], ['rm /x']],
    ])('stops at a dynamic word between %j and %j', (before, after) => {
      const [inner] = innerLines(head, [
        ...words(...before),
        { raw: '$SKIP', text: null },
        ...words(...after),
      ])
      expect(inner && innerReadable(inner)).toBe(false)
    })

    it('keeps the answer and program established by a literal prefix', () => {
      const dynamic: Word = { raw: '$ARG', text: null }
      expect(innerLines(head, [...words('--version'), dynamic])).toEqual([])
      const [inner] = innerLines(head, [...words('-c', 'echo safe'), dynamic])
      expect(inner?.line).toBe('echo safe')
    })
  })

  it.each<[string, boolean]>([
    ['missing-*', false],
    ['missing-?', false],
    ['missing-[ab]', false],
    ["'missing-'*", false],
    [String.raw`missing-\\*`, false],
    ['@(x|y)', false],
    ['!(x)', false],
    ['{a,b}', false],
    ["'missing-*'", true],
    ['"missing-*"', true],
    [String.raw`missing-\*`, true],
    [String.raw`missing-\[ab]`, true],
    ['missing-"*"', true],
  ])('preserves shell option glob quoting: %s', async (raw, stable) => {
    const parser = await getTestParser()
    const first = parser.parse(`bash --rcfile ${raw} --version -c 'rm /x'`).children[0]
    assert(first)
    const inner = innerLines(
      'bash',
      getParts(first)
        .slice(1)
        .map((part) => readWord(part)),
    )
    expect(inner.length === 0).toBe(stable)
    if (!stable) {
      expect(inner).toHaveLength(1)
      expect(inner[0] && innerReadable(inner[0])).toBe(false)
    }
  })
})
