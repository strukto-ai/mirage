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
import { type CommandFn, RegisteredCommand } from '../commands/config.ts'
import { CommandSpec, Operand, Option } from '../commands/spec/types.ts'
import { IOResult } from '../io/types.ts'
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { MountMode } from '../types.ts'
import { getTestParser, stderrStr, stdoutStr } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace/workspace.ts'

const ENC = new TextEncoder()

async function makeWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const ram = new RAMResource()
  const registry = new OpsRegistry()
  registry.registerResource(ram)
  return new Workspace(
    { '/data': ram },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
}

// A mount may register its own command under a builtin's name, and nothing
// refuses it. The measured per-program tables (USAGE_EXIT,
// USAGE_HINT_PREFIX, PYTHON_NAMES) describe the real program, so the
// borrowed name must answer as the control `mycmd` does. The session cwd is
// inside the mount because `resolveMount` picks the mount by the operand's
// path, and with the cwd outside every mount the name lookup would find the
// borrowed command by a different route. `test_registration.py` is the twin.
describe('a borrowed builtin name', () => {
  it('answers like a custom command', async () => {
    const ws = await makeWs()
    const spec = new CommandSpec({
      options: [new Option({ long: '--mode', type: 'str' })],
      rest: new Operand({ type: 'str' }),
    })
    const custom: CommandFn = () => [ENC.encode('custom\n'), new IOResult()]
    const mount = ws.mount('/data/')
    const names = ['grep', 'diff', 'python3', 'mycmd']
    for (const name of names) {
      if (name in mount.commands()) mount.unregister([name])
      mount.registerGeneral(
        new RegisteredCommand({ name, spec, resource: null, filetype: null, fn: custom }),
      )
    }
    try {
      for (const name of names) {
        const ok = await ws.execute(`cd /data && ${name} --mode=a x`)
        expect([ok.exitCode, stdoutStr(ok)], name).toEqual([0, 'custom\n'])
        const refused = await ws.execute(`cd /data && ${name} --bogus x`)
        expect(refused.exitCode, name).toBe(1)
        expect(stderrStr(refused), name).toBe(
          `${name}: unrecognized option '--bogus'\nTry '${name} --help' for more information.\n`,
        )
      }
    } finally {
      await ws.close()
    }
  })
})
