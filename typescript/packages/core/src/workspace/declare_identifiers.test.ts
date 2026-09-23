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

// Pinned against GNU bash 5.2.37 on debian:stable-slim. Deliberate
// divergence throughout: GNU prefixes `line N:` (`bash: line 1: export:
// ...`), which mirage omits, as every other mirage builtin does.
//
// `[command, stdout, stderr]`. A declaration builtin refuses a name it
// cannot declare rather than storing it: these used to exit 0 and land a
// variable that `$1BAD` can never name back, since bash reads that as
// `$1` followed by `BAD`.
const CASES: [string, string, string][] = [
  // Every declaration builtin refuses, each in its own voice.
  ['export 1BAD=x; echo rc=$?', 'rc=1\n', "bash: export: `1BAD=x': not a valid identifier\n"],
  ['readonly 2BAD=y; echo rc=$?', 'rc=1\n', "bash: readonly: `2BAD=y': not a valid identifier\n"],
  [
    'f() { local 3BAD=z; echo rc=$?; }; f',
    'rc=1\n',
    "bash: local: `3BAD=z': not a valid identifier\n",
  ],
  // `declare`/`typeset` share `local`'s handler and must still name
  // themselves rather than answer as `local`.
  ['declare 4BAD=w; echo rc=$?', 'rc=1\n', "bash: declare: `4BAD=w': not a valid identifier\n"],
  ['typeset 4BAD=w; echo rc=$?', 'rc=1\n', "bash: typeset: `4BAD=w': not a valid identifier\n"],
  // The bare form refuses too, and quotes the word as typed.
  ['export 5BAD; echo rc=$?', 'rc=1\n', "bash: export: `5BAD': not a valid identifier\n"],
  ['readonly 6BAD; echo rc=$?', 'rc=1\n', "bash: readonly: `6BAD': not a valid identifier\n"],
  // `-n` is still an export, so it validates like the on direction.
  ['export -n 7BAD; echo rc=$?', 'rc=1\n', "bash: export: `7BAD': not a valid identifier\n"],
  // A hyphen is not an identifier character; the whole word is quoted.
  ['export A-B=1; echo rc=$?', 'rc=1\n', "bash: export: `A-B=1': not a valid identifier\n"],
  // An array element parses as an assignment target but is not a plain
  // name, and GNU quotes just the target rather than the whole word.
  ['export arr[0]=1; echo rc=$?', 'rc=1\n', "bash: export: `arr[0]': not a valid identifier\n"],
  // One line per bad operand, in operand order.
  [
    'export 1BAD=x 2BAD=y; echo rc=$?',
    'rc=1\n',
    "bash: export: `1BAD=x': not a valid identifier\n" +
      "bash: export: `2BAD=y': not a valid identifier\n",
  ],
  // A leading underscore and a trailing digit are both legal.
  ['export _ok=1; echo rc=$?; export A1=2; echo rc=$?', 'rc=0\nrc=0\n', ''],
]

describe('declaration builtins refuse invalid identifiers', () => {
  it.each(CASES)('%s', async (cmd, out, err) => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell(cmd)
    expect(stdoutStr(io)).toBe(out)
    expect(stderrStr(io)).toBe(err)
    await ws.close()
  })

  it('lands the good names on the same line', async () => {
    // GNU reports each bad operand and keeps going, so the valid ones
    // are stored: refusing the whole line would be a second divergence.
    const { ws } = await makeWorkspace()
    const io = await ws.shell('export GOOD=1 1BAD=x GOOD2=2; echo rc=$?; declare -p GOOD GOOD2')
    expect(stdoutStr(io)).toBe('rc=1\ndeclare -x GOOD="1"\ndeclare -x GOOD2="2"\n')
    expect(stderrStr(io)).toBe("bash: export: `1BAD=x': not a valid identifier\n")
    await ws.close()
  })

  it('lets quoting decide whether an empty operand survives', async () => {
    // An unquoted expansion that comes back empty is removed by word
    // splitting, so `export $UNSET` is a bare `export` and prints the
    // listing. A quoted one is a real, empty operand and is refused.
    const empty = "bash: export: `': not a valid identifier\n"
    const { ws } = await makeWorkspace()
    const quoted = await ws.shell('export ""; echo rc=$?')
    expect(stdoutStr(quoted)).toBe('rc=1\n')
    expect(stderrStr(quoted)).toBe(empty)
    const expanded = await ws.shell('export "$NOPE"; echo rc=$?')
    expect(stdoutStr(expanded)).toBe('rc=1\n')
    expect(stderrStr(expanded)).toBe(empty)
    expect(stdoutStr(await ws.shell('export $NOPE'))).toMatch(/^declare -x /)
    await ws.close()
  })
})
