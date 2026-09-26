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

import { RAM_COMMANDS } from './index.ts'
import { describe, expect, it } from 'vitest'
import { materialize } from '../../../io/types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { MountMode } from '../../../types.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
const RAM_MKTEMP = RAM_COMMANDS.filter((c) => c.name === 'mktemp' && c.filetype == null)

const DEC = new TextDecoder()

async function runMktemp(
  flags: Record<string, string | boolean | number | string[]>,
  texts: string[] = [],
): Promise<{ out: string; vfs: RAMVFS }> {
  const vfs = new RAMVFS()
  const cmd = RAM_MKTEMP[0]
  if (cmd === undefined) throw new Error('mktemp not registered')
  const result = await cmd.fn((vfs as { accessor?: unknown }).accessor as never, [], texts, {
    stdin: null,
    flags,
    filetypeFns: null,
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
    const { out, vfs } = await runMktemp({}, ['/data/mt/f.XXXX'])
    const path = out.trim()
    expect(path.startsWith('/data/mt/f.')).toBe(true)
    expect(vfs.store.files.has(path)).toBe(true)
  })

  it('-d uses the directory of an explicit path template', async () => {
    const { out, vfs } = await runMktemp({ directory: true }, ['/data/mtd/t.XXXX'])
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
