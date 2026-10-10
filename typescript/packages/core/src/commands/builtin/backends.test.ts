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

import { describe, expect, it, vi } from 'vitest'
import { IOResult } from '../../io/types.ts'
import { BaseVFS } from '../../vfs/base.ts'
import { DevVFS } from '../../vfs/dev/dev.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { type Command, command } from '../config.ts'
import { specOf } from '../spec/builtins.ts'
import { commandsFor } from './backends.ts'
import { DEV_COMMANDS } from './dev/index.ts'

describe('commandsFor', () => {
  it('serves a builtin its own command module', () => {
    expect(commandsFor(new DevVFS())).toEqual([...DEV_COMMANDS])
  })

  it("serves a subclass its base's commands", () => {
    class Versioned extends DevVFS {}
    expect(commandsFor(new Versioned())).toEqual(commandsFor(new DevVFS()))
  })

  it('serves a VFS without a command module only what it was handed', () => {
    expect(commandsFor(new RAMVFS())).toEqual([])
    expect(commandsFor(new BaseVFS({ name: 'custom' }))).toEqual([])
  })

  it('serves a class named like a builtin no builtin commands', () => {
    class DevVFS extends BaseVFS {
      override readonly name: string = 'mydev'
    }
    expect(commandsFor(new DevVFS())).toEqual([])
  })

  it('serves a family registered by another copy of the package', async () => {
    vi.resetModules()
    const copy = await import('../../vfs/dev/dev.ts')
    const copyBackends = await import('./backends.ts')
    class Foreign extends copy.DevVFS {}
    const served = commandsFor(new Foreign())
    expect(served).toEqual(copyBackends.commandsFor(new Foreign()))
    expect(served).not.toEqual(commandsFor(new DevVFS()))
  })

  it('puts handed commands after the module they replace', () => {
    const cat = command({
      name: 'cat',
      vfs: 'ram',
      spec: specOf('cat'),
      fn: () => [new TextEncoder().encode('custom'), new IOResult()],
    })
    class Handed extends DevVFS {
      override commands(): readonly Command[] {
        return cat
      }
    }
    const cats = commandsFor(new Handed()).filter((cmd) => cmd.name === 'cat')
    expect(cats.at(-1)).toBe(cat[0])
  })
})
