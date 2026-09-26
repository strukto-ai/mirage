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
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { RAMVFS } from '../ram/ram.ts'
import { BinViewVFS } from './bin.ts'

const DEC = new TextDecoder()

describe('BinViewVFS', () => {
  it('registers reads and refuses every write op', () => {
    const vfs = new BinViewVFS(
      () => ['ls'],
      (name) => (name === 'ls' ? 'ls' : null),
    )
    const names = new Set(vfs.commands().map((cmd) => cmd.name))
    // Every generic command registers, the writers included: `gzip -c`
    // reads the view like any reader, and a line that writes is refused
    // at the op the view does not have.
    for (const name of ['cat', 'ls', 'stat', 'gzip', 'rm', 'cp']) {
      expect(names.has(name)).toBe(true)
    }
    const ops = new Map(vfs.ops().map((op) => [op.name, op]))
    for (const name of ['read', 'readdir', 'stat']) expect(ops.has(name)).toBe(true)
    for (const name of [
      'write',
      'append',
      'create',
      'mkdir',
      'unlink',
      'rmdir',
      'rename',
      'truncate',
      'setattr',
    ]) {
      expect(ops.get(name)?.write).toBe(true)
    }
  })

  it('refuses a write into the view as read-only', async () => {
    const ws = new Workspace(
      { '/': new RAMVFS() },
      { mode: MountMode.WRITE, shellParserFactory: getTestParser },
    )
    try {
      let io = await ws.shell('echo x > /usr/bin/ls')
      expect(io.exitCode).toBe(1)
      expect(DEC.decode(io.stderr)).toBe('/usr/bin/ls: Read-only file system\n')
      io = await ws.shell('chmod 644 /usr/bin/ls; stat -c %a /usr/bin/ls')
      expect(DEC.decode(io.stderr)).toBe(
        "chmod: changing permissions of '/usr/bin/ls': Read-only file system\n",
      )
      expect(DEC.decode(io.stdout)).toBe('755\n')
      io = await ws.shell('rm /usr/bin/ls; gzip -c /usr/bin/ls | gunzip | wc -l')
      expect(DEC.decode(io.stderr)).toBe(
        "rm: cannot remove '/usr/bin/ls': Operation not supported\n",
      )
      expect(DEC.decode(io.stdout)).not.toBe('0\n')
    } finally {
      await ws.close()
    }
  })
})
