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
import { QuickJsRuntime } from './runtime.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { MountMode, PathSpec } from '../../../types.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'

describe('QuickJS cwd', () => {
  it('inherits the captured cwd and honors an explicit one', async () => {
    const rt = new QuickJsRuntime()
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        shellParser: await getTestParser(),
        runtimes: [rt, 'workspace'],
      },
    )
    const args = { code: 'console.log(os.getcwd()[0])', args: [], env: {}, stdin: null }
    const dec = new TextDecoder()
    try {
      expect(
        (await ws.shell('mkdir /data/sub; echo child > /data/sub/item; cd /data')).exitCode,
      ).toBe(0)
      expect(dec.decode((await rt.run(args)).stdout)).toBe('/data\n')
      expect(
        dec.decode((await rt.run({ ...args, cwd: PathSpec.fromStrPath('/data/sub') })).stdout),
      ).toBe('/data/sub\n')
      const bad = await rt.run({
        ...args,
        code: "console.log('must not run')",
        cwd: PathSpec.fromStrPath('/missing'),
      })
      expect(bad.exitCode).toBe(1)
      expect(dec.decode(bad.stdout)).toBe('')
      expect(dec.decode(bad.stderr ?? new Uint8Array())).toContain('cannot change directory')
      expect(dec.decode((await rt.run(args)).stdout)).toBe('/data\n')
    } finally {
      await ws.close()
    }
  })
})
