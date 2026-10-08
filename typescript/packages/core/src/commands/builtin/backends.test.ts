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
import { IOResult } from '../../io/types.ts'
import { BaseVFS } from '../../vfs/base.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { command } from '../config.ts'
import { specOf } from '../spec/builtins.ts'
import { mountCommands } from './backends.ts'
import { RAM_COMMANDS } from './ram/index.ts'

describe('mountCommands', () => {
  it('serves a builtin its own command module', () => {
    expect(mountCommands(new RAMVFS())).toEqual([...RAM_COMMANDS])
  })

  it("serves a subclass its base's commands", () => {
    class Versioned extends RAMVFS {}
    expect(mountCommands(new Versioned())).toEqual(mountCommands(new RAMVFS()))
  })

  it('serves any other VFS the generic set under its name', () => {
    const served = mountCommands(new BaseVFS({ name: 'custom' }))
    const names = new Set(served.map((cmd) => cmd.name))
    for (const name of ['cat', 'ls', 'grep', 'find']) expect(names.has(name)).toBe(true)
    expect(new Set(served.map((cmd) => cmd.vfs))).toEqual(new Set(['custom']))
  })

  it('serves a class named like a builtin the generic set', () => {
    class SlackVFS extends BaseVFS {
      override readonly name: string = 'mychat'
    }
    const served = mountCommands(new SlackVFS())
    expect(served.some((cmd) => cmd.name === 'cat')).toBe(true)
    expect(new Set(served.map((cmd) => cmd.vfs))).toEqual(new Set(['mychat']))
  })

  it('puts handed commands after the generic set they override', () => {
    const cat = command({
      name: 'cat',
      vfs: 'custom',
      spec: specOf('cat'),
      fn: () => [new TextEncoder().encode('custom'), new IOResult()],
    })
    const vfs = new BaseVFS({ name: 'custom', overrides: new Set(['cat']), commands: cat })
    expect(mountCommands(vfs).filter((cmd) => cmd.name === 'cat')).toEqual(cat)
  })

  it('drops what a builtin overrides', () => {
    class Searchless extends RAMVFS {
      override readonly overrides: ReadonlySet<string> = new Set(['grep', 'rg'])
    }
    const names = new Set(mountCommands(new Searchless()).map((cmd) => cmd.name))
    expect(names.has('cat')).toBe(true)
    expect(names.has('grep') || names.has('rg')).toBe(false)
  })
})
