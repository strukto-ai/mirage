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
import type { Accessor } from '../../../accessor/base.ts'
import { runWithMountGate } from '../../../context/session_context.ts'
import { materialize } from '../../../io/types.ts'
import { MountMode, PathSpec } from '../../../types.ts'
import { answeringFiles } from '../../../test-utils.ts'
import { BUILDERS } from './builders/index.ts'
import { GENERIC_COMMANDS, generic, genericReading } from './factory.ts'

const DEC = new TextDecoder()

describe('GENERIC_COMMANDS', () => {
  it('has every builder whatever the backend lacks', () => {
    // A backend without the write-side functions still gets the whole
    // family: `gzip -c`, `tar -t` and `split -n 1/2` only read, and a line
    // that writes is refused at the missing function instead of the command
    // being absent.
    expect(new Set(GENERIC_COMMANDS.map((c) => c.name))).toEqual(
      new Set(BUILDERS.map((b) => b.name)),
    )
    expect(new Set(GENERIC_COMMANDS.map((c) => c.vfs))).toEqual(new Set([null]))
  })

  it('hands back the shared command', () => {
    expect(generic('grep')).toBe(GENERIC_COMMANDS.require('grep'))
  })

  it('registers a copy for one backend', () => {
    const ls = generic('ls', { vfs: 'dify' })
    expect([ls.name, ls.vfs]).toEqual(['ls', 'dify'])
    expect(ls).not.toBe(generic('ls'))
    expect(ls.spec).toEqual(generic('ls').spec)
    const cat = genericReading('cat', { vfs: 'ram', stream: () => null })
    expect([cat.name, cat.vfs]).toEqual(['cat', 'ram'])
  })

  it('refuses a name no builder has', () => {
    expect(() => generic('lss')).toThrow(/no generic command named 'lss'/)
    expect(() => generic('lss', { vfs: 'fake' })).toThrow(/no generic command named 'lss'/)
    expect(() => genericReading('lss', { vfs: 'fake' })).toThrow(/no generic command named 'lss'/)
  })

  it('refuses outside a workspace', async () => {
    // A builder reads and writes only through the session's files.
    const result = await generic('cat').fn({} as Accessor, [PathSpec.fromStrPath('/a')], [], {
      stdin: null,
      flags: {},
      cwd: PathSpec.fromStrPath('/'),
    })
    expect(result?.[1].exitCode).toBe(1)
    expect(DEC.decode(await materialize(result?.[1].stderr ?? null))).toBe(
      'cat: no workspace files\n',
    )
  })

  it('registers shuf as a writer', () => {
    // `shuf -o` may write, which policy reads; a backend with no write
    // function still serves it.
    expect(generic('shuf').write).toBe(true)
  })
})

describe('the slash guard on the write tier', () => {
  it('refuses a slashed write before the dispatcher', async () => {
    // open(2) with O_CREAT answers `x/` with EISDIR before looking anything
    // up, so `tee missing/` must not leave a regular file called `missing`
    // behind; a bare operand passes through.
    const written: string[] = []
    const vfs = answeringFiles({
      write: (path) => {
        written.push(path.virtual)
        return null
      },
      stat: () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      },
    })
    const run = (name: string, raw: string) =>
      runWithMountGate('/', MountMode.WRITE, async () => {
        const path = PathSpec.fromStrPath(raw)
        const result = await generic(name).fn({} as Accessor, [path], [], {
          stdin: name === 'tee' ? new Uint8Array() : null,
          flags: {},
          cwd: PathSpec.fromStrPath('/'),
          vfs,
        })
        await materialize(result?.[0] ?? null)
        return DEC.decode(await materialize(result?.[1].stderr ?? null))
      })
    expect(await run('tee', '/mnt/missing/')).toBe('tee: /mnt/missing/: Is a directory\n')
    expect(await run('tee', '/mnt/a.txt')).toBe('')
    expect(new Set(written)).toEqual(new Set(['/mnt/a.txt']))
  })
})
