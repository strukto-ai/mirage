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

import { commandIo } from '../../commands/builtin/generic_bind/adapter.ts'
import { GENERIC_COMMANDS } from '../../commands/builtin/generic_bind/factory.ts'
import { describe, expect, it } from 'vitest'
import { materialize, type IOResult } from '../../io/types.ts'
import { RAMVFS } from './ram.ts'
import { MountMode, type PathSpec } from '../../types.ts'
import type { CommandOpts } from '../../commands/config.ts'
import { mktempGeneric } from '../../commands/builtin/generic/mktemp.ts'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
const RAM_MKTEMP = GENERIC_COMMANDS.filter((c) => c.name === 'mktemp' && c.filetype == null)

const DEC = new TextDecoder()

async function runMktemp(
  flags: Record<string, string | boolean | number | string[]>,
  texts: string[] = [],
  dirs: string[] = [],
): Promise<{ out: string; vfs: RAMVFS }> {
  const vfs = new RAMVFS()
  for (const dir of dirs) vfs.store.dirs.add(dir)
  const cmd = RAM_MKTEMP[0]
  if (cmd === undefined) throw new Error('mktemp not registered')
  const result = await cmd.fn((vfs as { accessor?: unknown }).accessor as never, [], texts, {
    stdin: null,
    flags,
    io: commandIo(vfs),
    cwd: '/',
  })
  if (result === null) return { out: '', vfs }
  const [out] = result
  if (out === null) return { out: '', vfs }
  const buf = out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
  return { out: DEC.decode(buf), vfs }
}

describe('mktemp', () => {
  it('creates a temp file under /tmp', async () => {
    const { out, vfs } = await runMktemp({})
    const path = out.trim()
    expect(path.startsWith('/tmp/')).toBe(true)
    expect(vfs.store.files.has(path)).toBe(true)
  })

  it('-d creates a temp directory under /tmp', async () => {
    const { out, vfs } = await runMktemp({ directory: true })
    const path = out.trim()
    expect(path.startsWith('/tmp/')).toBe(true)
    expect(vfs.store.dirs.has(path)).toBe(true)
  })

  it('uses the directory of an explicit path template', async () => {
    const { out, vfs } = await runMktemp({}, ['/data/mt/f.XXXX'], ['/data', '/data/mt'])
    const path = out.trim()
    expect(path.startsWith('/data/mt/f.')).toBe(true)
    expect(vfs.store.files.has(path)).toBe(true)
  })

  it('-d uses the directory of an explicit path template', async () => {
    const { out, vfs } = await runMktemp(
      { directory: true },
      ['/data/mtd/t.XXXX'],
      ['/data', '/data/mtd'],
    )
    const path = out.trim()
    expect(path.startsWith('/data/mtd/t.')).toBe(true)
    expect(vfs.store.dirs.has(path)).toBe(true)
  })
})

async function readOnlyShell(
  seed: string,
  line: string,
): Promise<[number, string, string, string[]]> {
  const vfs = new RAMVFS()
  const ws = new Workspace(
    { '/ro/': [vfs, MountMode.WRITE] },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  try {
    const seeded = await ws.shell(seed)
    if (seeded.exitCode !== 0) throw new Error(DEC.decode(seeded.stderr))
    ws.setMountMode('/ro/', MountMode.READ)
    const before = [...vfs.store.files.keys()].sort()
    const r = await ws.shell(line)
    const after = [...vfs.store.files.keys()].sort()
    expect(after).toEqual(before)
    return [r.exitCode, DEC.decode(r.stdout), DEC.decode(r.stderr), after]
  } finally {
    await ws.close()
  }
}

describe('mktemp on a read-only mount', () => {
  // -u only prints the name it would have created, so it runs on a
  // read-only mount; a real create is refused at its write.
  it.each(['mktemp -u -p /ro', 'mktemp --dry-run -d -p /ro'])('runs %s', async (line) => {
    const [exitCode, out] = await readOnlyShell('true', line)
    expect(exitCode).toBe(0)
    expect(out.startsWith('/ro/tmp.')).toBe(true)
  })

  it.each(['mktemp -p /ro', 'mktemp -d -p /ro'])('refuses %s at its write', async (line) => {
    const [exitCode, , stderr] = await readOnlyShell('true', line)
    expect(exitCode).toBe(1)
    expect(stderr).toContain('Read-only file system')
  })
})

async function shellOf(
  mounts: Record<string, [RAMVFS, MountMode]>,
  line: string,
): Promise<[number, string, string]> {
  const ws = new Workspace(mounts, { mode: MountMode.WRITE, shellParser: await getTestParser() })
  try {
    const r = await ws.shell(line)
    return [r.exitCode, DEC.decode(r.stdout), DEC.decode(r.stderr)]
  } finally {
    await ws.close()
  }
}

describe('mktemp names and routing', () => {
  it('creates a pathless name under /tmp whatever the cwd', async () => {
    // The create goes where /tmp lives (the workspace root), not to the
    // mount the working directory is on, which here is read-only.
    const ro = new RAMVFS()
    const [exitCode, out] = await shellOf(
      { '/ro': [ro, MountMode.READ] },
      'cd /ro && mktemp && mktemp -d',
    )
    expect(exitCode).toBe(0)
    expect(
      out
        .split('\n')
        .filter(Boolean)
        .map((n) => n.startsWith('/tmp/tmp.')),
    ).toEqual([true, true])
    expect(ro.store.files.size).toBe(0)
  })

  // Pinned against GNU coreutils 9.7 (debian:stable-slim); a missing
  // directory is never created.
  it.each([
    [
      'mktemp -p /data/nodir',
      "mktemp: failed to create file via template '/data/nodir/tmp.XXXXXXXXXX': No such file or directory\n",
    ],
    [
      'mktemp -d --suffix=.s -p /data/nodir x.XXX',
      "mktemp: failed to create directory via template '/data/nodir/x.XXX.s': No such file or directory\n",
    ],
    [
      'cd /data && mktemp sub/x.XXX',
      "mktemp: failed to create file via template 'sub/x.XXX': No such file or directory\n",
    ],
    ['mktemp x.XX', "mktemp: too few X's in template 'x.XX'\n"],
    [
      'mktemp -p /data /abs/x.XXX',
      "mktemp: invalid template, '/abs/x.XXX'; with --tmpdir, it may not be absolute\n",
    ],
    [
      'mktemp -t sub/x.XXX',
      "mktemp: invalid template, 'sub/x.XXX', contains directory separator\n",
    ],
  ])('refuses %s in GNU words', async (line, stderr) => {
    const data = new RAMVFS()
    const [exitCode, , err] = await shellOf({ '/data': [data, MountMode.WRITE] }, line)
    expect([exitCode, err]).toEqual([1, stderr])
    expect(data.store.files.size).toBe(0)
  })

  it('creates a bare template relative to the cwd', async () => {
    const data = new RAMVFS()
    const [exitCode, out] = await shellOf(
      { '/data': [data, MountMode.WRITE] },
      'cd /data && mktemp x.XXX',
    )
    const name = out.trimEnd()
    expect(exitCode).toBe(0)
    expect(name.startsWith('x.') && name.length === 5).toBe(true)
    expect([...data.store.files.keys()]).toEqual([`/${name}`])
  })

  it('honors TMPDIR', async () => {
    const data = new RAMVFS()
    const [exitCode, out] = await shellOf(
      { '/data': [data, MountMode.WRITE] },
      'TMPDIR=/data mktemp; TMPDIR=/data mktemp -t -p /elsewhere f.XXX',
    )
    expect(exitCode).toBe(0)
    expect(
      out
        .split('\n')
        .filter(Boolean)
        .map((n) => n.startsWith('/data/tmp.') || n.startsWith('/data/f.')),
    ).toEqual([true, true])
    expect(data.store.files.size).toBe(2)
  })
})

// GNU creates exclusively and tries another name, so a taken name is never
// written over. Mirrors test_phase_r_paths.py.
describe('mktemp never reuses a taken name', () => {
  const opts = { stdin: null, flags: {}, cwd: '/data' } as CommandOpts

  it('draws again when a name is taken', async () => {
    const probed: string[] = []
    const written: string[] = []
    const result = await mktempGeneric(
      ['x.XXX'],
      opts,
      () => Promise.reject(new Error('a file create makes no directory')),
      (p) => {
        written.push(p.virtual)
        return Promise.resolve()
      },
      (p) => {
        probed.push(p.virtual)
        return Promise.resolve(probed.length === 1)
      },
    )
    const [out, io] = result as [Uint8Array, IOResult]
    expect(io.exitCode).toBe(0)
    expect(probed.length).toBe(2)
    expect(probed[0]).not.toBe(probed[1])
    expect(written).toEqual([probed[1]])
    expect(DEC.decode(out)).toBe(`${(probed[1] ?? '').slice('/data/'.length)}\n`)
  })

  it('gives up when every name is taken', async () => {
    const written: string[] = []
    const record = (p: PathSpec): Promise<void> => {
      written.push(p.virtual)
      return Promise.resolve()
    }
    const result = await mktempGeneric(['x.XXX'], opts, record, record, () => Promise.resolve(true))
    const [out, io] = result as [Uint8Array | null, IOResult]
    expect([out, io.exitCode, written]).toEqual([null, 1, []])
    expect(DEC.decode(io.stderr as Uint8Array)).toBe(
      "mktemp: failed to create file via template 'x.XXX': File exists\n",
    )
  })
})
