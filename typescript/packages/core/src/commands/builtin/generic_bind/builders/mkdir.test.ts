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

async function run(line: string): Promise<[number, string]> {
  const ws = new Workspace(
    { '/d': new Unattributed() },
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
})
