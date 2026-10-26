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

import { chmodSync, existsSync, statSync } from 'node:fs'
import { chmod, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commandsFor } from '@struktoai/mirage-core/workspace/mount/backends'
import { CapacityState, FileType, MountMode, PathSpec, VFSName } from '@struktoai/mirage-core/types'
import { VFSConfigError } from '@struktoai/mirage-core/vfs/errors'
import { ops } from '@struktoai/mirage-core/test-utils'
import { copy as copyCore } from '../../core/disk/copy.ts'
import { exists as existsCore } from '../../core/disk/exists.ts'
import { rmR as rmRCore } from '../../core/disk/rm.ts'
import { readStream as streamCore } from '../../core/disk/stream.ts'
import { spec, tmpRoot } from '../../../tests/test-utils.ts'
import { Workspace } from '../../workspace.ts'
import { DiskVFS } from './disk.ts'

const DEC = new TextDecoder()

// The walk find and du take over this mount, through one workspace, which
// closes the mount when it closes.
async function shell(vfs: DiskVFS, ...lines: string[]): Promise<string[]> {
  const ws = new Workspace({ '/data': vfs })
  try {
    const out: string[] = []
    for (const line of lines) out.push(DEC.decode((await ws.shell(line)).stdout))
    return out
  } finally {
    await ws.close()
  }
}

let root: string
let cleanup: () => void
let res: DiskVFS

beforeEach(() => {
  ;({ root, cleanup } = tmpRoot('mirage-diskvfs-'))
  res = new DiskVFS({ root })
})

afterEach(() => {
  cleanup()
})

describe('DiskVFS — identity', () => {
  it('exposes kind, vfsMd, root', () => {
    expect(res.name).toBe(VFSName.DISK)
    expect(typeof res.vfsMd).toBe('string')
    expect(res.root).toBe(root)
  })

  it('serves no commands of its own', () => {
    expect(commandsFor(res)).toEqual([])
  })

  it('capacity reports a real quota (df numbers, not fabricated)', async () => {
    const cap = await res.capacity()
    expect(cap.state).toBe(CapacityState.QUOTA)
    expect(cap.total ?? 0).toBeGreaterThan(0)
    expect(cap.available ?? -1).toBeGreaterThanOrEqual(0)
    expect(cap.inodes ?? 0).toBeGreaterThan(0)
  })
})

describe('DiskVFS — fs methods', () => {
  it('write + read round-trip', async () => {
    await ops(res).write(spec('/x.txt'), new TextEncoder().encode('hello'))
    const data = await ops(res).read(spec('/x.txt'))
    expect(new TextDecoder().decode(data)).toBe('hello')
  })

  it('write does not create parent dirs', async () => {
    // A write is not `mkdir -p`: GNU reports ENOENT on a missing parent.
    await expect(
      ops(res).write(spec('/a/b/c.txt'), new TextEncoder().encode('deep')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('append concatenates', async () => {
    await ops(res).write(spec('/a.txt'), new TextEncoder().encode('1'))
    await ops(res).append(spec('/a.txt'), new TextEncoder().encode('2'))
    expect(new TextDecoder().decode(await ops(res).read(spec('/a.txt')))).toBe('12')
  })

  it('readdir returns full virtual paths sorted', async () => {
    await ops(res).write(spec('/b.txt'), new Uint8Array())
    await ops(res).write(spec('/a.txt'), new Uint8Array())
    expect(await ops(res).readdir(spec('/'))).toEqual(['/a.txt', '/b.txt'])
  })

  it('stat distinguishes files and directories', async () => {
    await ops(res).write(spec('/file.txt'), new TextEncoder().encode('x'))
    await ops(res).mkdir(spec('/dir'))
    const f = await ops(res).stat(spec('/file.txt'))
    expect(f.size).toBe(1)
    expect(f.type).not.toBe(FileType.DIRECTORY)
    const d = await ops(res).stat(spec('/dir'))
    expect(d.type).toBe(FileType.DIRECTORY)
  })

  it('exists() is truthy for created files and falsy for missing', async () => {
    await ops(res).write(spec('/p.txt'), new Uint8Array())
    expect(await existsCore(res.accessor, spec('/p.txt'))).toBe(true)
    expect(await existsCore(res.accessor, spec('/nope.txt'))).toBe(false)
  })

  it('mkdir + rmdir', async () => {
    await ops(res).mkdir(spec('/d'))
    expect(await existsCore(res.accessor, spec('/d'))).toBe(true)
    await ops(res).rmdir(spec('/d'))
    expect(await existsCore(res.accessor, spec('/d'))).toBe(false)
  })

  it('unlink removes a file', async () => {
    await ops(res).write(spec('/x'), new Uint8Array())
    await ops(res).unlink(spec('/x'))
    expect(await existsCore(res.accessor, spec('/x'))).toBe(false)
  })

  it('rename moves a file', async () => {
    await ops(res).write(spec('/a'), new TextEncoder().encode('A'))
    await ops(res).rename(spec('/a'), spec('/b'))
    expect(await existsCore(res.accessor, spec('/a'))).toBe(false)
    expect(new TextDecoder().decode(await ops(res).read(spec('/b')))).toBe('A')
  })

  it('copy duplicates a file', async () => {
    await ops(res).write(spec('/src'), new TextEncoder().encode('CP'))
    await copyCore(res.accessor, spec('/src'), spec('/dst'))
    expect(new TextDecoder().decode(await ops(res).read(spec('/dst')))).toBe('CP')
  })

  it('truncate shrinks a file', async () => {
    await ops(res).write(spec('/t'), new TextEncoder().encode('hello'))
    await ops(res).truncate(spec('/t'), 2)
    expect(new TextDecoder().decode(await ops(res).read(spec('/t')))).toBe('he')
  })

  it('rmR removes a directory recursively', async () => {
    await ops(res).mkdir(spec('/d'))
    await ops(res).write(spec('/d/x.txt'), new TextEncoder().encode('x'))
    await rmRCore(res.accessor, spec('/d'))
    expect(await existsCore(res.accessor, spec('/d'))).toBe(false)
  })

  it('stream yields file bytes', async () => {
    await ops(res).write(spec('/big'), new TextEncoder().encode('chunk'))
    const chunks: Uint8Array[] = []
    for await (const c of streamCore(res.accessor, spec('/big'))) chunks.push(c)
    expect(new TextDecoder().decode(chunks[0])).toBe('chunk')
  })
})

describe('DiskVFS — getState / loadState round-trip', () => {
  it('snapshots files', async () => {
    await ops(res).write(spec('/a.txt'), new TextEncoder().encode('A'))
    await ops(res).mkdir(spec('/d'))
    await ops(res).write(spec('/d/b.txt'), new TextEncoder().encode('B'))

    const state = await res.getState()
    expect(Object.keys(state.files).sort()).toEqual(['a.txt', 'd/b.txt'])
    expect(state).not.toHaveProperty('needsOverride')
    expect(state).not.toHaveProperty('redactedFields')

    const { root: root2, cleanup: c2 } = tmpRoot('mirage-diskvfs-load-')
    try {
      const res2 = new DiskVFS({ root: root2 })
      await res2.loadState(state)
      expect(new TextDecoder().decode(await ops(res2).read(spec('/a.txt')))).toBe('A')
      expect(new TextDecoder().decode(await ops(res2).read(spec('/d/b.txt')))).toBe('B')
    } finally {
      c2()
    }
  })

  it('preserves file mode across a state round-trip', async () => {
    await ops(res).write(spec('/f.txt'), new TextEncoder().encode('hi'))
    chmodSync(join(root, 'f.txt'), 0o640)
    const state = await res.getState()
    expect(state.modes?.['f.txt']).toBe(0o640)

    const { root: root2, cleanup: c2 } = tmpRoot('mirage-diskvfs-mode-')
    try {
      const res2 = new DiskVFS({ root: root2 })
      await res2.loadState(state)
      expect(statSync(join(root2, 'f.txt')).mode & 0o777).toBe(0o640)
    } finally {
      c2()
    }
  })

  it('refuses a captured file replaced by a link', async () => {
    // A copy reads each file after the state named it; one swapped for a
    // link to a host file in between must not be copied through.
    await ops(res).write(spec('/f.txt'), new TextEncoder().encode('mine'))
    const state = await res.getState()
    const { root: other, cleanup: c2 } = tmpRoot('mirage-diskvfs-swap-')
    try {
      const secret = join(other, 'secret')
      await writeFile(secret, 'host')
      await unlink(join(root, 'f.txt'))
      await symlink(secret, join(root, 'f.txt'))
      const dst = join(other, 'dst')
      await expect(new DiskVFS({ root: dst }).loadState(state)).rejects.toThrow()
      expect(existsSync(join(dst, 'f.txt'))).toBe(false)
    } finally {
      c2()
    }
  })
})

interface HostFixture {
  files: Record<string, string>
  directories: string[]
  symlinks: Record<string, string>
  visible_files: string[]
  hidden_paths: string[]
}

describe('DiskVFS — shared host-link contract', () => {
  let fixture: HostFixture
  let vfs: DiskVFS

  beforeEach(async () => {
    fixture = JSON.parse(
      await readFile(
        new URL('../../../../../../integ/fixtures/disk/host-links.json', import.meta.url),
        'utf8',
      ),
    ) as HostFixture
    for (const [relative, text] of Object.entries(fixture.files)) {
      const full = join(root, relative)
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, text)
    }
    for (const relative of fixture.directories)
      await mkdir(join(root, relative), { recursive: true })
    for (const [relative, target] of Object.entries(fixture.symlinks))
      await symlink(target, join(root, relative))
    vfs = new DiskVFS({ root: join(root, 'root') })
  })

  it('uses the same visible tree for snapshots, find, du and the op table', async () => {
    expect(Object.keys((await vfs.getState()).files).sort()).toEqual(fixture.visible_files)
    expect(await shell(vfs, 'find /data -type f', 'du -s /data')).toEqual([
      fixture.visible_files.map((p) => `/data/${p}\n`).join(''),
      '13\t/data\n',
    ])
    for (const p of fixture.hidden_paths) {
      expect(await existsCore(vfs.accessor, spec(p))).toBe(false)
      await expect(ops(vfs).read(spec(p))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(
        ops(vfs).write(spec(p), new TextEncoder().encode('changed')),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(await readFile(join(root, 'outside/secret.txt'), 'utf8')).toBe('outside\n')
  })

  it('keeps the same visible tree when the mount root is an alias', async () => {
    const alias = join(root, 'alias')
    await symlink(vfs.root, alias)
    const mounted = new DiskVFS({ root: alias })
    expect(await shell(mounted, 'du -s /data')).toEqual(['13\t/data\n'])
    expect(Object.keys((await mounted.getState()).files).sort()).toEqual(fixture.visible_files)
  })

  it('requires an exact copy destination', async () => {
    await expect(
      copyCore(vfs.accessor, spec('/plain.txt'), spec('/destination')),
    ).rejects.toMatchObject({
      code: 'EISDIR',
    })
    expect(await readFile(join(root, 'outside/secret.txt'), 'utf8')).toBe('outside\n')
  })

  it.each(['escape', 'escape-dir/secret.txt', 'destination/plain.txt', '../outside/secret.txt'])(
    'refuses restoring through %s',
    async (relative) => {
      const before = statSync(join(root, 'outside/secret.txt')).mode
      await expect(
        vfs.loadState({
          type: 'disk',
          files: { [relative]: new TextEncoder().encode('changed') },
          modes: { [relative]: 0o600 },
        }),
      ).rejects.toThrow()
      expect(statSync(join(root, 'outside/secret.txt')).mode).toBe(before)
      expect(await readFile(join(root, 'outside/secret.txt'), 'utf8')).toBe('outside\n')
    },
  )

  it('creates missing restore parents and applies modes', async () => {
    await vfs.loadState({
      type: 'disk',
      files: { 'new/deep/file': new TextEncoder().encode('restored') },
      modes: { 'new/deep/file': 0o640 },
    })
    const target = join(root, 'root/new/deep/file')
    expect(await readFile(target, 'utf8')).toBe('restored')
    expect(statSync(target).mode & 0o777).toBe(0o640)
  })

  it('refuses absolute snapshot keys', async () => {
    const outside = join(root, 'outside/secret.txt')
    await expect(
      vfs.loadState({ type: 'disk', files: { [outside]: new TextEncoder().encode('changed') } }),
    ).rejects.toThrow(/relative/)
    expect(await readFile(outside, 'utf8')).toBe('outside\n')
  })

  it('does not stat unreadable symlink targets during snapshot capture', async () => {
    await chmod(join(root, 'outside'), 0)
    try {
      expect(Object.keys((await vfs.getState()).files).sort()).toEqual(fixture.visible_files)
    } finally {
      await chmod(join(root, 'outside'), 0o700)
    }
  })

  it('does not report unreadable trees as absent or empty', async () => {
    await chmod(join(root, 'root/lib'), 0)
    try {
      const file = PathSpec.fromStrPath('/data/lib/a.txt', 'lib/a.txt')
      const directory = PathSpec.fromStrPath('/data/lib', 'lib')
      await expect(existsCore(vfs.accessor, file)).rejects.toMatchObject({
        code: 'EACCES',
        message: file.virtual,
      })
      await expect(ops(vfs).readdir(directory)).rejects.toMatchObject({
        code: 'EACCES',
        message: directory.virtual,
      })
    } finally {
      await chmod(join(root, 'root/lib'), 0o700)
    }
  })
})

describe('DiskVFS — folder versions knob', () => {
  it.each(['no', 1, null])('folderVersions must be a boolean (%s)', (value) => {
    const fresh = join(root, 'never-made')
    expect(() => new DiskVFS({ root: fresh, folderVersions: value as unknown as boolean })).toThrow(
      new VFSConfigError('disk: folder_versions: must be a boolean'),
    )
    expect(existsSync(fresh)).toBe(false)
  })
})

describe('DiskVFS — cp of a file it may not use', () => {
  // GNU (coreutils 9.7) opens the source for reading, then creates the
  // destination, and names whichever one refused.
  it.skipIf(process.getuid?.() === 0)('names the operand that refused', async () => {
    await writeFile(join(root, 'secret'), 'x\n')
    await writeFile(join(root, 'plain'), 'y\n')
    await mkdir(join(root, 'ro'))
    await chmod(join(root, 'secret'), 0)
    await chmod(join(root, 'ro'), 0o555)
    const ws = new Workspace({ '/data': [res, MountMode.WRITE] as const })
    try {
      const unreadable = await ws.shell('cp /data/secret /data/copy')
      const unwritable = await ws.shell('cp /data/plain /data/ro/x')
      expect(unreadable.exitCode).toBe(1)
      expect(DEC.decode(unreadable.stderr)).toBe(
        "cp: cannot open '/data/secret' for reading: Permission denied\n",
      )
      expect(existsSync(join(root, 'copy'))).toBe(false)
      expect(unwritable.exitCode).toBe(1)
      expect(DEC.decode(unwritable.stderr)).toBe(
        "cp: cannot create regular file '/data/ro/x': Permission denied\n",
      )
    } finally {
      await chmod(join(root, 'secret'), 0o644)
      await chmod(join(root, 'ro'), 0o755)
      await ws.close()
    }
  })
})

describe('DiskVFS — cp -r past a folder it may not open', () => {
  // GNU (coreutils 9.7): `cp: cannot access 'src/locked': Permission
  // denied`, dst/locked is made, every other entry copies, exit 1.
  it.skipIf(process.getuid?.() === 0)('names the folder and copies the rest', async () => {
    await mkdir(join(root, 'src', 'locked'), { recursive: true })
    await mkdir(join(root, 'src', 'open'))
    await writeFile(join(root, 'src', 'locked', 'x.txt'), 'x\n')
    await writeFile(join(root, 'src', 'open', 'y.txt'), 'y\n')
    await writeFile(join(root, 'src', 'z.txt'), 'z\n')
    await chmod(join(root, 'src', 'locked'), 0)
    const ws = new Workspace({ '/data': [res, MountMode.WRITE] as const })
    try {
      const io = await ws.shell('cp -r /data/src /data/dst')
      expect(io.exitCode).toBe(1)
      expect(DEC.decode(io.stderr)).toBe(
        "cp: cannot access '/data/src/locked': Permission denied\n",
      )
      expect(statSync(join(root, 'dst', 'locked')).isDirectory()).toBe(true)
      expect(await readFile(join(root, 'dst', 'open', 'y.txt'), 'utf8')).toBe('y\n')
      expect(await readFile(join(root, 'dst', 'z.txt'), 'utf8')).toBe('z\n')
    } finally {
      await chmod(join(root, 'src', 'locked'), 0o755)
      await ws.close()
    }
  })
})
