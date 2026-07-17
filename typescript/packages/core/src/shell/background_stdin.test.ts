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
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { MountMode } from '../types.ts'
import { getTestParser, stdoutStr } from '../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'

// Port of tests/shell/test_background_jobs.py::test_background_does_not_consume_stdin.
// A backgrounded command must NOT read from the shell's stdin — otherwise the
// foreground consumer starves. `sleep 0 & cat` should emit whatever arrived on
// stdin via `cat` on the foreground.

const ENC = new TextEncoder()

describe('background jobs + stdin (port of tests/shell/test_background_jobs.py)', () => {
  it('sleep 0 & cat → cat receives stdin, not the backgrounded sleep', async () => {
    const parser = await getTestParser()
    const ram = new RAMResource()
    const registry = new OpsRegistry()
    registry.registerResource(ram)
    const ws = new Workspace(
      { '/data': ram },
      { mode: MountMode.WRITE, ops: registry, shellParser: parser },
    )
    ws.getSession(ws.defaultSessionId).cwd = '/data'
    const io = await ws.execute('sleep 0 & cat', { stdin: ENC.encode('hello\n') })
    if (!('stdout' in io)) throw new Error('expected ExecuteResult')
    expect(stdoutStr(io).trim()).toBe('hello')
    await ws.close()
  })
})
