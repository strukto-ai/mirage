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
import { IOResult, materialize } from '../../../../io/types.ts'
import { JobConsole } from '../../../../shell/console/job_console.ts'
import { ExitSignal } from '../../../../shell/errors.ts'
import { MountMode } from '../../../../types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import type { ExecuteFn } from '../../../expand/types.ts'
import { MountRegistry } from '../../../mount/registry.ts'
import { SessionState } from '../../../session/session.ts'
import { Workspace } from '../../../workspace/workspace.ts'
import { handleExecCommand } from './exec.ts'

describe('exec cmd streams', () => {
  it.each([
    ['exec yes | head -n1; echo "${PIPESTATUS[@]}"', 'y\n141 0\n'],
    ['( exec yes ) | head -n1; echo "${PIPESTATUS[@]}"', 'y\n141 0\n'],
    ['{ exec yes; } | head -n1; echo "${PIPESTATUS[@]}"', 'y\n141 0\n'],
    ['f() { exec yes; }; f | head -n2', 'y\ny\n'],
    ["exec sh -c 'echo a >> /data/ran; yes' | head -n1; cat /data/ran", 'y\na\n'],
  ])('%s', async (command, stdout) => {
    // The program writes where the statement writes as it runs, so a
    // reader that stops early stops it (bash 5.2 on debian:stable-slim:
    // `exec yes | head -n1` is `y` and `141 0`).
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      const r = await ws.shell(command)
      expect([r.stdoutText, r.exitCode]).toEqual([stdout, 0])
    } finally {
      await ws.close()
    }
  })

  it('hands on returned output unread', async () => {
    // With nowhere to write, what the program returned rides the signal as
    // it is, for the boundary the signal reaches to read.
    const registry = new MountRegistry({}, MountMode.WRITE)
    const session = new SessionState({ sessionId: 's' })
    const seen: (JobConsole | undefined)[] = []
    async function* returned(): AsyncGenerator<Uint8Array> {
      yield await Promise.resolve(new TextEncoder().encode('out\n'))
    }
    const stream = returned()
    const executeFn: ExecuteFn = (_line, opts) => {
      seen.push(opts.sink)
      return Promise.resolve(
        new IOResult({ stdout: stream, stderr: new TextEncoder().encode('err\n'), exitCode: 3 }),
      )
    }
    const raised: unknown = await handleExecCommand(
      ['echo', 'x'],
      session,
      executeFn,
      registry,
    ).catch((thrown: unknown) => thrown)
    expect(raised).toBeInstanceOf(ExitSignal)
    const sig = raised as ExitSignal
    expect(seen).toEqual([undefined])
    expect(sig.stdout).toBe(stream)
    expect([sig.exitCode, new TextDecoder().decode(sig.stderr)]).toEqual([3, 'err\n'])
    expect(new TextDecoder().decode(await materialize(sig.stdout))).toBe('out\n')
    const sink = new JobConsole()
    await handleExecCommand(['echo', 'x'], session, executeFn, registry, null, sink).catch(
      (thrown: unknown) => thrown,
    )
    expect(seen.at(-1)).toBe(sink)
  })
})
