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
import { eacces } from '../../../../errors/fs.ts'
import { getTestParser } from '../../../../../tests/workspace/fixtures/workspace_fixture.ts'
import { type FileStat, FileType, MountMode, type PathSpec } from '../../../../types.ts'
import { BaseVFS } from '../../../../vfs/base.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'

// A RAM store with no setattr and no directory times, as an object store
// is: a mode and a made directory's time land in the overlay.
class Unattributed extends RAMVFS {
  static {
    Object.defineProperty(
      this.prototype,
      'setattr',
      Object.getOwnPropertyDescriptor(BaseVFS.prototype, 'setattr') ?? {},
    )
  }

  override async stat(path: PathSpec): Promise<FileStat> {
    const row = await super.stat(path)
    return row.type === FileType.DIRECTORY ? row.with({ modified: null }) : row
  }
}

// A store that keeps no empty directory, as hf does: mkdir succeeds and
// makes nothing until a key lands below.
class Unkept extends Unattributed {
  override mkdir(): Promise<void> {
    return Promise.resolve()
  }
}

// A store whose `-p` chain stops after its first directory, as one whose
// second marker write is refused does.
class Halting extends Unattributed {
  override mkdir(path: PathSpec, parents = false): Promise<void> {
    if (!parents) return super.mkdir(path, parents)
    this.store.dirs.add('/p')
    return Promise.reject(eacces(path))
  }
}

async function run(line: string, vfs: RAMVFS = new Unattributed()): Promise<[number, string]> {
  const ws = new Workspace(
    { '/d': vfs },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  try {
    const result = await ws.shell(line)
    return [result.exitCode, result.stdoutText]
  } finally {
    await ws.close()
  }
}

describe('mkdir on a store without attributes', () => {
  it('lands a mode where a chmod would', async () => {
    expect(
      await run(
        "mkdir -p -m 700 /d/a/kid && (umask 077; mkdir /d/m) && stat -c '%n %a' /d/a /d/a/kid /d/m",
      ),
    ).toEqual([0, '/d/a 755\n/d/a/kid 700\n/d/m 700\n'])
  })

  it('times every directory -p makes', async () => {
    expect(
      await run(
        'touch -d 2000-01-01 /d/ref && mkdir -p /d/p/a/b && find /d/p -newer /d/ref | sort',
      ),
    ).toEqual([0, '/d/p\n/d/p/a\n/d/p/a/b\n'])
  })

  it.each([
    ['ram', () => new RAMVFS()],
    ['unattributed', () => new Unattributed()],
  ])('leaves a directory -p finds its mode (%s)', async (_name, make) => {
    expect(
      await run(
        'mkdir /d/e && chmod 750 /d/e && (umask 077; mkdir -p /d/e) && mkdir -p -m 700 /d/e && stat -c %a /d/e',
        make(),
      ),
    ).toEqual([0, '750\n'])
  })

  it('takes a mask on a store keeping no empty directory', async () => {
    expect(
      await run('(umask 077; mkdir -p /d/new) && mkdir -m 700 /d/other && echo ok', new Unkept()),
    ).toEqual([0, 'ok\n'])
  })

  it('times what a chain that fails partway made', async () => {
    expect(
      await run(
        'touch -d 2000-01-01 /d/ref; mkdir -p /d/p/a/b; echo rc=$?; find /d/p -newer /d/ref',
        new Halting(),
      ),
    ).toEqual([0, 'rc=1\n/d/p\n'])
  })
})
