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
import { MountMode } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { PyodideRuntime } from './runtime.ts'

const DEC = new TextDecoder()

// The os.getxattr family a pyodide guest gets over the workspace door:
// what the shell sets the guest reads, what the guest sets the shell
// reads, and a missing attribute is linux's ENODATA.
describe('pyodide extended attributes', { timeout: 120_000 }, () => {
  it('are served by the workspace door through the worker', async () => {
    const rt = new PyodideRuntime()
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.EXEC, runtimes: [rt, 'workspace'], shellParser: await getTestParser() },
    )
    try {
      await ws.shell('echo hi > /data/f && setfattr -n user.tag -v shell /data/f')
      const guest = [
        'import errno, os',
        'print(os.getxattr("/data/f", "user.tag"))',
        'os.setxattr("/data/f", "user.guest", b"g")',
        'print(os.listxattr("/data/f"))',
        'try:',
        '    os.getxattr("/data/f", "user.none")',
        'except OSError as exc:',
        '    print(exc.errno == errno.ENODATA)',
      ].join('\n')
      await ws.vfs.writeFile('/data/probe.py', guest)
      const ran = await ws.shell('python3 /data/probe.py')
      expect(DEC.decode(ran.stderr)).toBe('')
      expect(DEC.decode(ran.stdout)).toBe("b'shell'\n['user.guest', 'user.tag']\nTrue\n")
      const read = await ws.shell('getfattr -n user.guest --only-values /data/f')
      expect(DEC.decode(read.stdout)).toBe('g')
    } finally {
      await ws.close()
    }
  })

  it('answer ENOTSUP where no worker can wait on the door', async () => {
    const rt = new PyodideRuntime()
    try {
      const out = await rt.eval(
        [
          'import errno, os',
          'try:',
          '    os.listxattr("/data")',
          '    answer = "served"',
          'except OSError as exc:',
          '    answer = exc.errno == errno.ENOTSUP',
          'answer',
        ].join('\n'),
      )
      expect(out.value).toBe(true)
    } finally {
      await rt.close()
    }
  })
})
