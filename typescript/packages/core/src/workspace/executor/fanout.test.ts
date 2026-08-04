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
import { IOResult, materialize } from '../../io/types.ts'
import { RAMResource } from '../../resource/ram/ram.ts'
import { FileStat, FileType, MountMode, type PathSpec } from '../../types.ts'
import { MountRegistry } from '../mount/registry.ts'
import type { MountEntry } from '../mount/mount.ts'
import { Session } from '../session/session.ts'
import type { ExecuteNodeFn } from './jobs.ts'
import type { DispatchFn } from './cross_mount.ts'
import { handleCommand } from './command.ts'
import { basename } from '../../core/ram/utils.ts'

const NEVER_EXECUTE: ExecuteNodeFn = () => {
  throw new Error('executeNode should not have been called')
}

// `find` resolves its start point through the dispatcher, because a start
// point the router followed into another mount can only be statted there.
// Anything else reaching the dispatcher is still a test failure.
const STAT_ONLY_DISPATCH: DispatchFn = ((op: string, path: PathSpec) => {
  if (op !== 'stat') throw new Error(`dispatch(${op}) should not have been called`)
  return Promise.resolve([
    new FileStat({ name: basename(path.virtual), type: FileType.DIRECTORY }),
    new IOResult(),
  ])
}) as unknown as DispatchFn

function wireMount(mount: MountEntry): void {
  const cmds = mount.resource.commands?.()
  if (cmds !== undefined) {
    for (const cmd of cmds) {
      if (cmd.filetype !== null) mount.register(cmd)
      else if (cmd.resource === null) mount.registerGeneral(cmd)
      else mount.register(cmd)
    }
  }
}

function wireRegistry(reg: MountRegistry): void {
  for (const m of reg.allMounts()) wireMount(m)
}

describe('fanOutTraversal glob matching', () => {
  it('find -name with a lone [ does not throw', async () => {
    const reg = new MountRegistry(
      { '/data/': new RAMResource(), '/data/sub/': new RAMResource() },
      MountMode.WRITE,
    )
    wireRegistry(reg)
    const s = new Session({ sessionId: 'test', cwd: '/' })
    const [, io] = await handleCommand(
      NEVER_EXECUTE,
      STAT_ONLY_DISPATCH,
      reg,
      ['find', '/data', '-name', '['],
      s,
    )
    expect(typeof io.exitCode).toBe('number')
  })

  it('find -name matches descendant mount names with [...] classes like Python', async () => {
    const reg = new MountRegistry(
      { '/data/': new RAMResource(), '/data/sub1/': new RAMResource() },
      MountMode.WRITE,
    )
    wireRegistry(reg)
    const s = new Session({ sessionId: 'test', cwd: '/' })
    const [out, io] = await handleCommand(
      NEVER_EXECUTE,
      STAT_ONLY_DISPATCH,
      reg,
      ['find', '/data', '-name', 'sub[0-9]'],
      s,
    )
    expect(io.exitCode).toBe(0)
    const text = out === null ? '' : new TextDecoder().decode(await materialize(out))
    expect(text).toContain('/data/sub1')
  })
})

describe('fanOutTraversal mount-entry synthesis honors the expression tree', () => {
  async function runFind(argv: string[]): Promise<string> {
    const reg = new MountRegistry(
      {
        '/data/': new RAMResource(),
        '/data/ram/': new RAMResource(),
        '/data/disk/': new RAMResource(),
      },
      MountMode.WRITE,
    )
    wireRegistry(reg)
    const s = new Session({ sessionId: 'test', cwd: '/' })
    const [out] = await handleCommand(NEVER_EXECUTE, STAT_ONLY_DISPATCH, reg, argv, s)
    return out === null ? '' : new TextDecoder().decode(await materialize(out))
  }

  it('-not -name excludes the matching mount', async () => {
    const text = await runFind(['find', '/data', '-not', '-name', 'ram'])
    expect(text).not.toContain('/data/ram')
    expect(text).toContain('/data/disk')
  })

  it('-o ORs the two name patterns', async () => {
    const text = await runFind(['find', '/data', '-name', 'ram', '-o', '-name', 'disk'])
    expect(text).toContain('/data/ram')
    expect(text).toContain('/data/disk')
  })

  it('-type f excludes mount directories', async () => {
    const text = await runFind(['find', '/data', '-type', 'f'])
    expect(text).not.toContain('/data/ram')
    expect(text).not.toContain('/data/disk')
  })
})

describe('fanOutTraversal -maxdepth applies to child-mount depth', () => {
  it('a deeper child entry beyond the budget is excluded', async () => {
    const child = new RAMResource()
    child.store.dirs.add('/a')
    child.store.files.set('/a/b.txt', new TextEncoder().encode('deep\n'))
    const reg = new MountRegistry({ '/': new RAMResource(), '/data/': child }, MountMode.WRITE)
    wireRegistry(reg)
    const s = new Session({ sessionId: 'test', cwd: '/' })
    const [out] = await handleCommand(
      NEVER_EXECUTE,
      STAT_ONLY_DISPATCH,
      reg,
      ['find', '/', '-maxdepth', '2'],
      s,
    )
    const text = out === null ? '' : new TextDecoder().decode(await materialize(out))
    expect(text).toContain('/data/a')
    expect(text).not.toContain('/data/a/b.txt')
  })
})
