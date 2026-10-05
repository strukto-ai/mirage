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

import { expect, it } from 'vitest'
import type { FlagValue } from '../../commands/spec/types.ts'
import { Limit, MountMode, PathSpec } from '../../types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'
import { shouldFanOut } from './fanout.ts'

async function nested(): Promise<Workspace> {
  return new Workspace(
    { '/base': new RAMVFS(), '/base/inner': new RAMVFS(), '/other': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
}

it.each([
  ['find', {}, true],
  ['du', {}, true],
  ['du', { one_file_system: true }, false],
  ['ls', {}, false],
  ['ls', { recursive: true }, true],
  ['grep', {}, false],
  ['grep', { r: true }, true],
  ['cat', {}, false],
] as [string, Record<string, FlagValue>, boolean][])(
  'a walk fans out over a nested mount: %s %j',
  async (cmd, flags, expected) => {
    const ws = await nested()
    const path = PathSpec.fromStrPath('/base')
    expect(shouldFanOut(cmd, [path], flags, ws.registry)).toBe(expected)
    await ws.close()
  },
)

it('no nested mount and a refused operand stay single', async () => {
  const ws = await nested()
  expect(shouldFanOut('find', [PathSpec.fromStrPath('/other')], {}, ws.registry)).toBe(false)
  const refused = new PathSpec({
    virtual: '/base',
    directory: '/base',
    vfsPath: 'base',
    walkError: 'ENOENT',
  })
  expect(shouldFanOut('find', [refused], {}, ws.registry)).toBe(false)
  await ws.close()
})

it.each(['find /base', 'du /base', 'ls -R /base'])(
  "a hidden mount's limit does not bound the walk: %s",
  async (line) => {
    const ws = new Workspace(
      { '/base': new RAMVFS(), '/base/inner': new RAMVFS(), '/base/seen': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: await getTestParser() },
    )
    const name = line.split(' ')[0] ?? ''
    ws.registry.mountFor('/base/inner/').commandLimits.set(name, new Limit({ maxLines: 1 }))
    ws.createSession('agent', { profile: { paths: { hide: ['/base/inner'] } } })
    try {
      const result = await ws.shell(line, { sessionId: 'agent' })
      expect(result.exitCode).toBe(0)
      expect(new TextDecoder().decode(result.stdout)).not.toContain('inner')
      expect(new TextDecoder().decode(result.stderr)).not.toContain('truncated')
    } finally {
      await ws.close()
    }
  },
)
