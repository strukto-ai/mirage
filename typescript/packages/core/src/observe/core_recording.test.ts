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
import { RAMVFS } from '../vfs/ram/ram.ts'
import { MountMode, PathSpec, VFSName } from '../types.ts'
import { Workspace } from '../workspace/workspace/workspace.ts'
import { runWithRecording } from './context.ts'

function call(
  registry: OpsRegistry,
  name: string,
  ram: RAMVFS,
  path: string,
  ...args: unknown[]
): Promise<unknown> {
  return registry.call(name, VFSName.RAM, ram.accessor, PathSpec.fromStrPath(path), args)
}

function setup(): { ram: RAMVFS; registry: OpsRegistry } {
  const ram = new RAMVFS()
  const registry = new OpsRegistry()
  new Workspace({ '/ram': ram }, { mode: MountMode.WRITE, ops: registry })
  return { ram, registry }
}

describe('core ram ops emit OpRecords inside runWithRecording', () => {
  it('read records op="read" with correct byte count and source="ram"', async () => {
    const { ram, registry } = setup()
    ram.store.files.set('/hello.txt', new TextEncoder().encode('hello world'))
    const [data, records] = await runWithRecording(async () => {
      return (await call(registry, 'read', ram, '/hello.txt')) as Uint8Array
    })
    expect(new TextDecoder().decode(data)).toBe('hello world')
    expect(records).toHaveLength(1)
    expect(records[0]?.op).toBe('read')
    expect(records[0]?.bytes).toBe(11)
    expect(records[0]?.source).toBe('ram')
  })

  it('write records op="write" with correct byte count', async () => {
    const { ram, registry } = setup()
    ram.store.dirs.add('/')
    const [, records] = await runWithRecording(async () => {
      await call(registry, 'write', ram, '/hello.txt', new TextEncoder().encode('hello'))
    })
    expect(records).toHaveLength(1)
    expect(records[0]?.op).toBe('write')
    expect(records[0]?.bytes).toBe(5)
  })

  it('append records op="append" with correct byte count', async () => {
    const { ram, registry } = setup()
    ram.store.dirs.add('/')
    const [, records] = await runWithRecording(async () => {
      await call(registry, 'append', ram, '/test.jsonl', new TextEncoder().encode('hello'))
    })
    expect(records).toHaveLength(1)
    expect(records[0]?.op).toBe('append')
    expect(records[0]?.bytes).toBe(5)
    expect(records[0]?.source).toBe('ram')
  })

  it('outside a recording scope, reads still succeed and emit no records', async () => {
    const { ram, registry } = setup()
    ram.store.files.set('/hello.txt', new TextEncoder().encode('hello'))
    const data = (await call(registry, 'read', ram, '/hello.txt')) as Uint8Array
    expect(new TextDecoder().decode(data)).toBe('hello')
  })
})
