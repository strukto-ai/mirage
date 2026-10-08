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
import { MountMode } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'

const ALL = 'Linux mirage mirage #1 Mirage x86_64 GNU/Linux\n'

async function makeWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const ram = new RAMVFS()
  return new Workspace({ '/ram': ram }, { mode: MountMode.WRITE, shellParser: parser })
}

// GNU's layout, measured on coreutils 9.7 (debian:stable-slim): no option is
// -s, fields print in one fixed order whatever order they were typed in, and
// -a drops the processor and hardware platform when unknown. The values are
// mirage's fixed identity. Mirrors test_uname.py.
describe('uname', () => {
  it.each([
    ['uname', 'Linux\n'],
    ['uname -s', 'Linux\n'],
    ['uname --kernel-name', 'Linux\n'],
    ['uname -n', 'mirage\n'],
    ['uname -r', 'mirage\n'],
    ['uname -v', '#1 Mirage\n'],
    ['uname -m', 'x86_64\n'],
    ['uname -p', 'unknown\n'],
    ['uname -i', 'unknown\n'],
    ['uname -o', 'GNU/Linux\n'],
    ['uname -a', ALL],
    ['uname --all', ALL],
    ['uname -a -p', ALL],
    ['uname -snrvmpio', 'Linux mirage mirage #1 Mirage x86_64 unknown unknown GNU/Linux\n'],
    ['uname -ms', 'Linux x86_64\n'],
    ['uname -o -n', 'mirage GNU/Linux\n'],
    ['uname -s -s', 'Linux\n'],
  ])('%s', async (line, out) => {
    const ws = await makeWs()
    const io = await ws.shell(line)
    await ws.close()
    expect([io.stdoutText, io.stderrText, io.exitCode]).toEqual([out, '', 0])
  })

  it.each([
    ['uname x', "uname: extra operand 'x'\nTry 'uname --help' for more information.\n"],
    ['uname -s x', "uname: extra operand 'x'\nTry 'uname --help' for more information.\n"],
    ['uname -z', "uname: invalid option -- 'z'\nTry 'uname --help' for more information.\n"],
  ])('%s refuses', async (line, err) => {
    const ws = await makeWs()
    const io = await ws.shell(line)
    await ws.close()
    expect([io.stdoutText, io.stderrText, io.exitCode]).toEqual(['', err, 1])
  })
})
