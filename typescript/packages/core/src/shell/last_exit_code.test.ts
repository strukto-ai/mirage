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

import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { makeWorkspace, stdoutStr } from '../../tests/workspace/fixtures/workspace_fixture.ts'

// Direct port of tests/shell/test_last_exit_code.py. The Python fixture
// (tests/shell/conftest.py) diffs mirage against real /bin/sh via
// subprocess.run(capture_output=True) — which does NOT throw on non-zero
// exit. spawnSync has the same non-throwing behavior; execFileSync would
// throw on `false && echo $?` (exit 1) and break the harness.

function native(cmd: string): string {
  const r = spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' })
  return r.stdout
}

async function mirage(cmd: string): Promise<string> {
  const { ws } = makeWorkspace()
  try {
    const io = await ws.shell(cmd)
    return stdoutStr(io)
  } finally {
    await ws.close()
  }
}

async function assertParity(cmd: string): Promise<void> {
  const [m, n] = [await mirage(cmd), native(cmd)]
  expect(m).toBe(n)
}

describe('shell $? parity with /bin/sh (port of tests/shell/test_last_exit_code.py)', () => {
  it.each([
    'true; echo $?',
    'false; echo $?',
    'true | false; echo $?',
    'false | true; echo $?',
    'true && echo $?',
    'false && echo $?',
    'false || echo $?',
    'true || echo $?',
    'true && false; echo $?',
    'false || true; echo $?',
    'if true; then echo $?; fi',
    'if false; then echo a; else echo $?; fi',
    'false; true; echo $?',
    'true; false; echo $?',
    'false; if true; then echo $?; fi',
    'true; (false); echo $?',
    'false; while false; do echo x; done; echo $?',
    '! true; echo $?',
    '! false; echo $?',
  ])('%s', assertParity)
})
