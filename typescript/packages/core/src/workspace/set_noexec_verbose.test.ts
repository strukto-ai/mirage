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

import { describe, expect, it } from 'vitest'
import { makeWorkspace, stderrStr, stdoutStr } from './fixtures/workspace_fixture.ts'

// Pinned against GNU bash 5.2.37 on debian:stable-slim.
const NOEXEC: [string, string][] = [
  ['set -n; echo hi', ''],
  ['echo a; set -n; echo b; echo c', 'a\n'],
  // One-way within the same input: `set +n` is itself a statement, so
  // it never runs. GNU behaves the same way.
  ['set -n; set +n; echo after', ''],
  ['echo a; set -o noexec; echo b', 'a\n'],
  // A subshell is its own shell, so `set -n` stops it and nothing leaks
  // back out. Integ caught this: the check lived only in the program
  // loop, and `handleSubshell` runs a second statement loop.
  ['(set -n; echo hi); echo rc=$?', 'rc=0\n'],
  ['echo a; (set -n; echo b); echo c', 'a\nc\n'],
  ['(set -n; set +n; echo after); echo rc=$?', 'rc=0\n'],
  ['(set -n; echo x); echo still-here', 'still-here\n'],
  ['echo a; echo b', 'a\nb\n'],
]

const VERBOSE: [string, string, string][] = [
  // The unit is an input line, not a statement: the line that turned
  // the option on was already read, so nothing is echoed for it.
  ['set -v; echo hi', 'hi\n', ''],
  ['set -v; echo a; set +v; echo b', 'a\nb\n', ''],
  ['set -v\necho a\necho b', 'a\nb\n', 'echo a\necho b\n'],
  // `set +v` is echoed because the option is still on when its line
  // reaches the reader; the line after it is not.
  ['set -v\necho a\nset +v\necho b', 'a\nb\n', 'echo a\nset +v\n'],
  // A statement spanning several lines carries all of them.
  ['set -v\nfor i in 1 2; do\n echo $i\ndone', '1\n2\n', 'for i in 1 2; do\n echo $i\ndone\n'],
  // The reader consumes every line, not just the ones carrying a
  // statement, so comments and blank lines between commands are echoed
  // too. Clamping the range to the next executable row dropped them.
  ['set -v\n# note\n\necho ok', 'ok\n', '# note\n\necho ok\n'],
  ['set -v\necho a\n\necho b', 'a\nb\n', 'echo a\n\necho b\n'],
  // A comment run before the first command is echoed with it.
  ['set -v\n# one\n# two\necho ok', 'ok\n', '# one\n# two\necho ok\n'],
]

describe('set -n noexec', () => {
  it.each(NOEXEC)('%s', async (cmd, out) => {
    const { ws } = await makeWorkspace()
    expect(stdoutStr(await ws.shell(cmd))).toBe(out)
    await ws.close()
  })
})

describe('set -v verbose', () => {
  it.each(VERBOSE)('%s', async (cmd, out, err) => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell(cmd)
    expect(stdoutStr(io)).toBe(out)
    expect(stderrStr(io)).toBe(err)
    await ws.close()
  })
})

describe('set -o listing', () => {
  it('matches the GNU defaults', async () => {
    const { ws } = await makeWorkspace()
    const text = stdoutStr(await ws.shell('set -o'))
    // The three GNU turns on for a non-interactive shell, and nothing else.
    const on = text
      .split('\n')
      .filter((ln) => ln.endsWith('on'))
      .map((ln) => ln.split(/\s+/)[0])
    expect(on).toEqual(['braceexpand', 'hashall', 'interactive-comments'])
    expect(text.startsWith('allexport      \toff\n')).toBe(true)
    expect(text).toContain('interactive-comments\ton\n')
    await ws.close()
  })

  it('is re-readable under +o', async () => {
    const { ws } = await makeWorkspace()
    const text = stdoutStr(await ws.shell('set +o'))
    expect(text.startsWith('set +o allexport\nset -o braceexpand\n')).toBe(true)
    expect(text).toContain('set +o xtrace\n')
    await ws.close()
  })
})

describe('brace expansion follows its option', () => {
  it('expands by default and not under +B', async () => {
    const { ws } = await makeWorkspace()
    expect(stdoutStr(await ws.shell('echo {a,b}'))).toBe('a b\n')
    expect(stdoutStr(await ws.shell('set +B; echo {a,b}'))).toBe('{a,b}\n')
    expect(stdoutStr(await ws.shell('set -o'))).toContain('braceexpand    \toff\n')
    await ws.close()
  })
})

describe('noexec stops a nested statement runner', () => {
  // `set -n` stops everything after it at every depth, not only at the
  // top of the input. GNU answers each of these with nothing at all: the
  // option is read by the reader, so the statements after it are never
  // executed wherever they sit. The check lived in the program loop
  // alone, so `set -n` worked flat and silently did nothing one
  // construct deep. Pinned on bash 5.2.37, debian:stable-slim.
  const CASES = [
    'if true; then set -n; echo BAD; fi; echo rc=1',
    'f(){ set -n; echo BAD; }; f; echo rc=2',
    'for i in 1 2; do set -n; echo BAD; done; echo rc=3',
    '{ set -n; echo BAD; }; echo rc=4',
    'while true; do set -n; echo BAD; break; done; echo rc=5',
    'case x in x) set -n; echo BAD;; esac; echo rc=6',
    'for ((i=0;i<3;i++)); do set -n; echo BAD; done; echo rc=7',
    'until false; do set -n; echo BAD; done; echo rc=8',
  ]
  it.each(CASES)('%s', async (cmd) => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell(cmd)
    expect(stdoutStr(io)).toBe('')
    expect(stderrStr(io)).toBe('')
    await ws.close()
  })
})
