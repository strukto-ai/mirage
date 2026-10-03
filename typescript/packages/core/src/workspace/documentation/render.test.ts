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
import { MountMode } from '../../types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { SharePointVFS } from '../../vfs/sharepoint/sharepoint.ts'
import { Workspace } from '../workspace/workspace.ts'

describe('vfsMd', () => {
  it('states each mount mode', async () => {
    const ws = new Workspace(
      {
        '/': [new RAMVFS(), MountMode.EXEC],
        '/data': [new RAMVFS(), MountMode.READ],
        '/scratch': [new RAMVFS(), MountMode.WRITE],
      },
      { mode: MountMode.WRITE },
    )
    const markdown = await ws.vfsMd()
    expect(markdown).toContain('## `/data`\n\nBackend: `ram`. Access: read-only.')
    expect(markdown).toContain('## `/scratch`\n\nBackend: `ram`. Access: read-write.')
    expect(markdown).toContain('## `/`\n\nBackend: `ram`. Access: read-write; programs can run.')
  })

  it('keeps literal braces', async () => {
    const ws = new Workspace(
      { '/sp': [new SharePointVFS({ accessToken: 'tok' }), MountMode.READ] },
      { mode: MountMode.READ },
    )
    expect(await ws.vfsMd()).toContain('/{site_name}/{library_name}/{path_to_file}')
    expect(await ws.vfsMd()).not.toContain('{prefix}')
  })
})
