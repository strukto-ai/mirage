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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { MountMode } from '../types.ts'
import { getTestParser, stderrStr, stdoutStr } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace/workspace.ts'

// The lines cover every surface the path axis gates: enumeration (ls,
// globs, find), the native fast paths (du -s, find on a backend with a
// find op), the walk (grep -r, du -a), stat and read. The pin is
// "no hide -> identical results": an active-gate that misfires on an
// empty document changes one side and this battery goes red.
const BATTERY = [
  'ls /a',
  'ls -la /a && ls /b',
  'echo /a/* /b/*',
  'find /a',
  'find /b -type f',
  'du -s /a',
  'du -a /b',
  'grep -rl needle /a /b',
  'cat /a/x.txt /b/deep/y.txt',
  "stat -c '%n %s' /a/x.txt",
  'test -d /a/sub && echo yes',
]

const open: Workspace[] = []

beforeEach(() => {
  // Independent workspaces must render the same fixture timestamps.
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-01-01T00:00:00Z') })
})

afterEach(async () => {
  for (const ws of open.splice(0)) await ws.close()
  vi.useRealTimers()
})

async function seeded(): Promise<Workspace> {
  const parser = await getTestParser()
  const a = new RAMResource()
  const b = new RAMResource()
  const registry = new OpsRegistry()
  registry.registerResource(a)
  registry.registerResource(b)
  const ws = new Workspace(
    {
      '/a': [a, MountMode.WRITE] as const,
      '/b': [b, MountMode.WRITE] as const,
    },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
  open.push(ws)
  const io = await ws.execute(
    'mkdir -p /a/sub /b/deep && ' +
      "printf 'needle a\\n' > /a/x.txt && " +
      "printf 'plain\\n' > /a/sub/inner.txt && " +
      "printf 'needle b\\n' > /b/deep/y.txt",
  )
  expect(io.exitCode).toBe(0)
  return ws
}

async function outputs(
  ws: Workspace,
  sessionId: string,
): Promise<[string, number, string, string][]> {
  const out: [string, number, string, string][] = []
  for (const line of BATTERY) {
    const io = await ws.execute(line, { sessionId })
    out.push([line, io.exitCode, stdoutStr(io), stderrStr(io)])
  }
  return out
}

describe('the empty-profile pin', () => {
  it('an empty profile changes nothing', async () => {
    // profile {} compiles to all-null narrowing, so every gate must
    // stay inert: the battery is byte-identical to a session with no
    // profile at all.
    const bare = await seeded()
    bare.createSession('probe')
    const profiled = await seeded()
    profiled.createSession('probe', { profile: {} })
    expect(await outputs(bare, 'probe')).toEqual(await outputs(profiled, 'probe'))
  })

  it('a hide on one mount leaves the other byte identical', async () => {
    // The per-operand gate: hiding one entry under /a flips /a's walks
    // off their fast paths, and /b must not notice, whichever path its
    // commands take. Byte-identical output is the whole claim, so a
    // native-op/walk divergence on /b surfaces here.
    const bareWs = await seeded()
    bareWs.createSession('probe')
    const hiddenWs = await seeded()
    hiddenWs.createSession('probe', { profile: { paths: { hide: ['/a/sub'] } } })
    const bLines = BATTERY.filter((line) => !line.includes('/a'))
    const bare = (await outputs(bareWs, 'probe')).filter((r) => bLines.includes(r[0]))
    const hidden = (await outputs(hiddenWs, 'probe')).filter((r) => bLines.includes(r[0]))
    expect(bare).toEqual(hidden)
  })
})
