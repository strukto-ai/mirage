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
import { GENERIC_COMMANDS } from '../../commands/builtin/generic_bind/factory.ts'
import { Command } from '../../commands/config.ts'
import { MountMode, PathSpec } from '../../types.ts'
import { backendCommands } from '../../workspace/mount/backends.ts'
import { MountEntry } from '../../workspace/mount/mount.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { declared } from '../call.ts'
import { WRITE_EFFECTS } from '../constants.ts'
import { RAMVFS } from '../ram/ram.ts'
import { BinViewVFS } from './bin.ts'

const DEC = new TextDecoder()

describe('BinViewVFS', () => {
  it('registers reads and refuses every write op', () => {
    const vfs = new BinViewVFS(
      () => ['ls'],
      (name) => (name === 'ls' ? 'ls' : null),
    )
    const names = new Set(
      [...GENERIC_COMMANDS, ...backendCommands(vfs), ...vfs.commands()].flatMap((cmd) =>
        cmd instanceof Command ? [cmd.name] : [],
      ),
    )
    // Every generic command registers, the writers included: `gzip -c`
    // reads the view like any reader, and a line that writes is refused
    // at the op the view does not have.
    for (const name of ['cat', 'ls', 'stat', 'gzip', 'rm', 'cp']) {
      expect(names.has(name)).toBe(true)
    }
    const mount = new MountEntry({ prefix: '/', vfs })
    for (const name of ['read', 'readdir', 'stat']) expect(mount.answers(name)).toBe(true)
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
      const effect = declared(BinViewVFS, name)?.effect
      expect(
        mount.answers(name) &&
          effect !== undefined &&
          WRITE_EFFECTS.some((writeEffect) => writeEffect === effect),
      ).toBe(true)
    }
  })

  it('refuses a write into the view as read-only', async () => {
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      let io = await ws.shell('echo x > /usr/bin/ls')
      expect(io.exitCode).toBe(1)
      expect(DEC.decode(io.stderr)).toBe('bash: line 1: /usr/bin/ls: Read-only file system\n')
      io = await ws.shell('chmod 644 /usr/bin/ls; stat -c %a /usr/bin/ls')
      expect(DEC.decode(io.stderr)).toBe(
        "chmod: changing permissions of '/usr/bin/ls': Read-only file system\n",
      )
      expect(DEC.decode(io.stdout)).toBe('755\n')
      io = await ws.shell('rm /usr/bin/ls; gzip -c /usr/bin/ls | gunzip | wc -l')
      expect(DEC.decode(io.stderr)).toBe("rm: cannot remove '/usr/bin/ls': Read-only file system\n")
      expect(DEC.decode(io.stdout)).not.toBe('0\n')
    } finally {
      await ws.close()
    }
  })

  it('reads a name Mirage does not run from the file beneath the view', async () => {
    const root = await rootHolding({ '/usr/bin/perl': '#!perl\n', '/usr/bin/grep': 'theirs\n' })
    const ws = new Workspace({ '/': root }, { mode: MountMode.WRITE })
    try {
      expect(DEC.decode((await ws.shell('cat /usr/bin/perl')).stdout)).toBe('#!perl\n')
      const listed = await ws.shell('ls /usr/bin | grep -x -e perl -e grep')
      expect(DEC.decode(listed.stdout)).toBe('grep\nperl\n')
      const grep = DEC.decode((await ws.shell('cat /usr/bin/grep')).stdout)
      expect(grep).not.toBe('theirs\n')
      expect(grep).toContain('grep')
      expect((await ws.shell('cat /usr/bin/nosuch')).exitCode).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it('keeps its own file for a name it leaves where none lies beneath', async () => {
    const beneath = await rootHolding({ '/usr/bin/perl': '#!perl\n' })
    const view = new BinViewVFS(
      () => ['ls', 'python3'],
      (n) => (n === 'ls' || n === 'python3' ? n : null),
      (n) => n !== 'ls',
      (v) => [beneath, PathSpec.fromStrPath(v)],
    )
    const rows = await view.readdir(
      new PathSpec({ virtual: '/usr/bin', directory: '/usr', vfsPath: '' }),
    )
    expect(rows.map((row) => row.name)).toEqual(['ls', 'perl', 'python3'])
    const perl = new PathSpec({ virtual: '/usr/bin/perl', directory: '/usr/bin', vfsPath: 'perl' })
    expect((await view.stat(perl)).size).toBe('#!perl\n'.length)
    expect(DEC.decode((await view.read(perl)) as Uint8Array)).toBe('#!perl\n')
    const python = new PathSpec({
      virtual: '/usr/bin/python3',
      directory: '/usr/bin',
      vfsPath: 'python3',
    })
    expect(DEC.decode((await view.read(python)) as Uint8Array)).toContain('python3')
    expect(view.leaves('perl') && !view.leaves('ls')).toBe(true)
  })

  it('opens a folder beneath the view with all under it', async () => {
    const root = await rootHolding({})
    await root.mkdir(PathSpec.fromStrPath('/usr/bin/helpers'))
    await root.write(
      PathSpec.fromStrPath('/usr/bin/helpers/tool'),
      new TextEncoder().encode('#!tool\n'),
    )
    const ws = new Workspace({ '/': root }, { mode: MountMode.WRITE })
    try {
      const io = await ws.shell(
        'ls /usr/bin | grep -x helpers; ls /usr/bin/helpers; ' +
          'cat /usr/bin/helpers/tool; test -d /usr/bin/helpers && echo dir',
      )
      expect(DEC.decode(io.stdout)).toBe('helpers\ntool\n#!tool\ndir\n')
      expect((await ws.shell('ls /usr/bin/grep/x')).exitCode).toBe(2)
    } finally {
      await ws.close()
    }
  })
})

async function rootHolding(files: Record<string, string>): Promise<RAMVFS> {
  const ram = new RAMVFS()
  await ram.mkdir(PathSpec.fromStrPath('/usr/bin'), true)
  for (const [path, data] of Object.entries(files))
    await ram.write(PathSpec.fromStrPath(path), new TextEncoder().encode(data))
  return ram
}
