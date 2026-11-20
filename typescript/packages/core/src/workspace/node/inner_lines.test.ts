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
import { NodeType as NT } from '../../shell/types.ts'
import {
  innerLines,
  innerReadable,
  programLines,
  readWord,
  readsOfTest,
  wordValue,
  type Word,
} from './inner_lines.ts'
import { setProgramInvocation } from '../../context/session_context.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { SessionState } from '../session/session.ts'
import { Workspace } from '../workspace/workspace.ts'
import { parse } from '../../shell/parse/parse.ts'

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
    ['bash', ['-c', '-x', 'rm /x'], [['line', 'rm /x', false]]],
    ['mapfile', ['-C', 'rm /x', 'arr'], [['line', 'rm /x', true]]],
    // A command already split into words.
    ['command', ['-p', 'rm', '/x'], [['argv', ['rm', '/x'], false]]],
    ['exec', ['-a', 'name', 'rm', '/x'], [['argv', ['rm', '/x'], false]]],
    ['env', ['-i', '-u', 'HOME', 'A=1', 'rm', '/x'], [['argv', ['rm', '/x'], false]]],
    ['timeout', ['-s', 'KILL', '5', 'rm', '/x'], [['argv', ['rm', '/x'], false]]],
    ['nohup', ['rm', '/x'], [['argv', ['rm', '/x'], false]]],
    ['nohup', ['--help'], []],
    // bash runs the named builtin with the words as given, so
    // `builtin eval 'rm /x'` is eval's line, admitted in turn.
    ['builtin', ['eval', 'rm /x'], [['argv', ['eval', 'rm /x'], false]]],
    ['builtin', ['--', 'echo', 'hi'], [['argv', ['echo', 'hi'], false]]],
    ['builtin', [], []],
    ['nice', ['-n', '5', 'rm', '/x'], [['argv', ['rm', '/x'], false]]],
    ['nice', ['--ad', '5', 'rm', '/x'], [['argv', ['rm', '/x'], false]]],
    // GNU env splits -S's value into the command line itself.
    ['env', ['-S', 'rm /x'], [['none', null, false]]],
    ['env', ['--split-string=rm /x'], [['none', null, false]]],
    ['env', ['-iS', 'rm /x'], [['none', null, false]]],
    ['env', ['-uPATHS', 'rm'], [['argv', ['rm'], false]]],
    // -C and -a take a value as -u does, and the first of them in a cluster
    // takes the rest of it: `-Cu tmp` changes to `u`.
    ['env', ['-C', 'tmp', 'rm'], [['argv', ['rm'], false]]],
    ['env', ['-a', 'x', 'rm'], [['argv', ['rm'], false]]],
    ['env', ['-vC', 'tmp', 'rm'], [['argv', ['rm'], false]]],
    ['env', ['-Cu', 'tmp', 'rm'], [['argv', ['tmp', 'rm'], false]]],
    ['env', ['-ua', 'x', 'rm'], [['argv', ['x', 'rm'], false]]],
    ['env', ['--chdir', 'tmp', 'rm'], [['argv', ['rm'], false]]],
    ['env', ['--chd', 'tmp', 'rm'], [['argv', ['rm'], false]]],
    ['env', ['--chdir=tmp', 'rm'], [['argv', ['rm'], false]]],
    ['env', ['--argv0', 'x', 'rm'], [['argv', ['rm'], false]]],
    ['env', ['--arg', 'x', 'rm'], [['argv', ['rm'], false]]],
    ['env', ['--uns', 'HOME', 'rm'], [['argv', ['rm'], false]]],
    ['ionice', ['-c', '3', 'rm', '/x'], [['argv', ['rm', '/x'], false]]],
    // A trap's action is a line the shell runs when a condition fires; `-`, a
    // number first, one operand or an option sets no action.
    ['trap', ['rm /x', 'EXIT'], [['line', 'rm /x', false]]],
    ['trap', ['--', 'rm /x', 'INT', 'TERM'], [['line', 'rm /x', false]]],
    ['trap', ['-', 'EXIT'], []],
    ['trap', ['2', '3'], []],
    ['trap', ['\u0663', 'INT'], [['line', '\u0663', false]]],
    ['trap', ['EXIT'], []],
    ['trap', ['-p', 'EXIT'], []],
    ['trap', ['-l'], []],
    ['coproc', ['rm', '/x'], [['argv', ['rm', '/x'], false]]],
    ['coproc', [], []],
    // What later words run, loaded from where the gate cannot read.
    ['hash', ['-p', '/bin/rm', 'ls'], [['none', null, false]]],
    ['hash', ['-rp', '/bin/rm', 'ls'], [['none', null, false]]],
    ['hash', ['-r'], []],
    ['enable', ['-f', 'x.so', 'rm'], [['none', null, false]]],
    ['enable', ['-n', 'echo'], []],
    ['alias', ['x=rm /x'], [['none', null, false]]],
    ['alias', ['-p'], []],
    ['alias', ['ll'], []],
    ['env', ['PS4=$(rm)', 'bash', '-xc', ':'], [['none', null, false]]],
    ['env', ['-i', 'BASH_ENV=/x', 'sh'], [['none', null, false]]],
    ['env', ['ENV=/x', 'sh'], [['argv', ['sh'], false]]],
    ['env', ['BASH_FUNC_ls%%=() { rm; }', 'ls'], [['none', null, false]]],
    ['bash', ['-ic', 'rm /x'], [['none', null, false]]],
    ['sh', ['-l', '-c', 'rm /x'], [['none', null, false]]],
    ['bash', ['--login', '-c', 'rm /x'], [['none', null, false]]],
    ['bash', ['-o', 'vi', '-lc', 'rm /x'], [['none', null, false]]],
    ['bash', ['-c', 'rm /x', '-i'], [['line', 'rm /x', false]]],
    ['bash', ['-c', '-l', 'rm /x'], [['none', null, false]]],
    ['bash', ['-c', '-x', 'rm /x'], [['line', 'rm /x', false]]],
    ['env', ['-a', '-sh', 'sh'], [['none', null, false]]],
    ['env', ['--argv0=-sh', 'sh'], [['none', null, false]]],
    ['exec', ['-l', 'bash'], [['none', null, false]]],
    ['exec', ['-a', '-bash', 'bash'], [['none', null, false]]],
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
    const [unknown] = innerLines('bash', [...words('-c'), dynamic, ...words('rm /x')])
    expect(unknown && innerReadable(unknown)).toBe(false)
    const [alias] = innerLines('alias', [{ raw: '"$a"', text: null }])
    expect(alias && innerReadable(alias)).toBe(false)
    expect(innerLines('bash', [...words('--version'), dynamic])).toEqual([])
    const [stable] = innerLines('sh', [...words('-c', 'echo safe'), dynamic])
    expect(stable?.line).toBe('echo safe')
  })

  it.each<[string, boolean]>([
    ['$SKIP', false],
    ['"$SKIP"', false],
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
  ])('requires stable shell option words: %s', (raw, stable) => {
    const first = parse(`bash --rcfile ${raw} --version -c 'rm /x'`).children[0]
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

describe('readsOfTest', () => {
  it.each<[string, [string[], boolean][]]>([
    [
      '[[ ! -e /x && a == b* ]]',
      [
        [['[[', '-e', '/x'], true],
        [['[[', 'a', '==', 'b*'], false],
      ],
    ],
  ])('reads %s as the tests the gate admits', (line, reads) => {
    // `[ ]` whole with its bracket, as the command `[` is; `[[ ]]` a leaf at
    // a time, its pattern side left to the gate, which reads it in the
    // matcher's dialect.
    const stack = [parse(line)]
    while (stack.length > 0 && stack[stack.length - 1]?.type !== NT.TEST_COMMAND) {
      const node = stack.pop()
      if (node !== undefined) stack.push(...[...node.children].reverse())
    }
    const test = stack[stack.length - 1]
    assert(test)
    const got = readsOfTest(test).map((read) => [read.words.map(wordValue), read.stated])
    expect(got).toEqual(reads)
  })
})

describe('programLines', () => {
  it.each([
    [['timeout', '1', 'rm', '/x']],
    [['env', 'rm', '/x']],
    [['xargs', 'rm']],
    [['sh', '-c', 'rm /x']],
  ])('runs nothing under a shadowing function: %j', async (texts) => {
    const ws = new Workspace({ '/': new RAMVFS() })
    const session = new SessionState({ sessionId: 't' })
    const head = texts[0] ?? ''
    expect(programLines(words(...texts), session, ws.registry)).not.toEqual([])
    session.functions[head] = `${head}() { :; }`
    expect(programLines(words(...texts), session, ws.registry)).toEqual([])
    await setProgramInvocation(session, () => {
      expect(programLines(words(...texts), session, ws.registry)).not.toEqual([])
      return Promise.resolve()
    })
  })
})
