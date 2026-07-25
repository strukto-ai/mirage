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
import { materialize } from '../../../io/types.ts'
import { OpsRegistry, type RegisteredOp } from '../../../ops/registry.ts'
import { RAMResource } from '../../../resource/ram/ram.ts'
import { type CommandOpts } from '../../config.ts'
import { FileStat, type FileStatInit, FileType, MountMode, PathSpec } from '../../../types.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace.ts'
import { statGeneric } from './stat.ts'

const MTIME = '2026-01-02T15:30:45Z'
const MTIME_EPOCH = '1767367845'
const DEC = new TextDecoder()

function fs(overrides: Partial<FileStatInit> = {}): FileStat {
  return new FileStat({
    name: 'f.txt',
    size: 6,
    modified: MTIME,
    type: FileType.TEXT,
    ...overrides,
  })
}

function opts(fmt: string): CommandOpts {
  return {
    stdin: null,
    flags: { c: fmt },
    filetypeFns: null,
    cwd: '/',
    resource: null,
  } as unknown as CommandOpts
}

async function render(fmt: string, s: FileStat): Promise<string> {
  const result = await statGeneric([PathSpec.fromStrPath('/data/f.txt')], opts(fmt), () =>
    Promise.resolve(s),
  )
  if (result === null) throw new Error('statGeneric returned null')
  const [out, io] = result
  expect(io.exitCode).toBe(0)
  return DEC.decode(await materialize(out)).replace(/\n$/, '')
}

// Like render, but for a custom operand path and keeping the trailing newline
// (used to assert %N quoting byte-for-byte).
async function renderNamed(fmt: string, name: string): Promise<string> {
  const result = await statGeneric([PathSpec.fromStrPath(name)], opts(fmt), () =>
    Promise.resolve(fs()),
  )
  if (result === null) throw new Error('statGeneric returned null')
  return DEC.decode(await materialize(result[0]))
}

class NoSetattrRegistry extends OpsRegistry {
  override register(ro: RegisteredOp): void {
    if (ro.name === 'setattr') return
    super.register(ro)
  }
}

async function run(ws: Workspace, cmd: string): Promise<[number, string, string]> {
  const r = await ws.execute(cmd)
  return [r.exitCode, r.stdoutText, r.stderrText]
}

describe('stat -c directive formatting', () => {
  it('renders name, quoted name, size, and type', async () => {
    expect(await render('%n', fs())).toBe('/data/f.txt')
    expect(await render('%N', fs())).toBe("'/data/f.txt'")
    expect(await render('%s', fs({ size: 42 }))).toBe('42')
    expect(await render('%s', fs({ size: null }))).toBe('0')
    expect(await render('%F', fs())).toBe('regular file')
    expect(await render('%F', fs({ type: FileType.DIRECTORY }))).toBe('directory')
  })

  it('renders mode directives with defaults and explicit bits', async () => {
    expect(await render('%a', fs({ mode: null }))).toBe('644')
    expect(await render('%A', fs({ mode: null }))).toBe('-rw-r--r--')
    expect(await render('%f', fs({ mode: null }))).toBe('81a4')
    expect(await render('%a', fs({ mode: 0o640 }))).toBe('640')
    expect(await render('%A', fs({ mode: 0o640 }))).toBe('-rw-r-----')
    expect(await render('%f', fs({ mode: 0o640 }))).toBe('81a0')
    expect(await render('%a', fs({ mode: 0o4755 }))).toBe('4755')
    expect(await render('%f', fs({ mode: 0o4755 }))).toBe('89ed')
  })

  it('renders directory mode defaults', async () => {
    const d = fs({ type: FileType.DIRECTORY, size: null, mode: null })
    expect(await render('%a', d)).toBe('755')
    expect(await render('%A', d)).toBe('drwxr-xr-x')
    expect(await render('%f', d)).toBe('41ed')
    expect(await render('%s', d)).toBe('0')
  })

  it('renders setuid/setgid/sticky bits in %A', async () => {
    expect(await render('%A', fs({ mode: 0o4755 }))).toBe('-rwsr-xr-x')
    expect(await render('%A', fs({ mode: 0o4644 }))).toBe('-rwSr--r--')
    expect(await render('%A', fs({ mode: 0o2755 }))).toBe('-rwxr-sr-x')
    expect(await render('%A', fs({ mode: 0o1755 }))).toBe('-rwxr-xr-t')
    expect(await render('%A', fs({ mode: 0o1644 }))).toBe('-rw-r--r-T')
  })

  it('parses printf flags/width/precision, not as the directive', async () => {
    expect(await render('%04a', fs({ mode: 0o644 }))).toBe('0644')
    expect(await render('%#a', fs({ mode: 0o4755 }))).toBe('04755')
    expect(await render('%-8a|', fs({ mode: 0o4755 }))).toBe('4755    |')
    expect(await render('%6s', fs({ size: 1 }))).toBe('     1')
    expect(await render('%-6s|', fs({ size: 1 }))).toBe('1     |')
    expect(await render('%5i', fs())).toBe('    ?')
    expect(await render('%.3F', fs())).toBe('reg')
  })

  it('shell-quotes %N safely', async () => {
    expect(await render('%N', fs())).toBe("'/data/f.txt'")
    expect(await renderNamed('%N', "/data/a'b.txt")).toBe('"/data/a\'b.txt"\n')
    expect(await renderNamed('%N', '/data/a\'b"c')).toBe("'/data/a'\\''b\"c'\n")
  })

  it('renders owner directives, falling back to "user"', async () => {
    const owned = fs({ uid: 1000, gid: 'dev' })
    expect(await render('%u %U %g %G', owned)).toBe('1000 1000 dev dev')
    expect(await render('%u %U %g %G', fs({ uid: null, gid: null }))).toBe('user user user user')
  })

  it('renders time directives and epochs', async () => {
    const s = fs({ modified: MTIME, atime: '2026-03-04T05:06:07Z' })
    expect(await render('%y', s)).toBe(MTIME)
    expect(await render('%Y', s)).toBe(MTIME_EPOCH)
    expect(await render('%z', s)).toBe(MTIME)
    expect(await render('%Z', s)).toBe(MTIME_EPOCH)
    expect(await render('%x', s)).toBe('2026-03-04T05:06:07Z')
    expect(await render('%X', s)).toBe('1772600767')
  })

  it('falls back atime to mtime when absent', async () => {
    const s = fs({ modified: MTIME, atime: null })
    expect(await render('%x', s)).toBe(MTIME)
    expect(await render('%X', s)).toBe(MTIME_EPOCH)
  })

  it('renders birth sentinels and epoch of unknown time', async () => {
    expect(await render('%w', fs())).toBe('-')
    expect(await render('%W', fs())).toBe('0')
    expect(await render('%Y', fs({ modified: null }))).toBe('0')
  })

  it('renders structural constants', async () => {
    expect(await render('%B', fs())).toBe('512')
    expect(await render('%r %R %t %T', fs())).toBe('0 0 0 0')
  })

  it('renders "?" for unbacked and unknown directives', async () => {
    for (const spec of ['%i', '%d', '%D', '%h', '%b', '%o', '%m', '%C', '%q']) {
      expect(await render(spec, fs())).toBe('?')
    }
  })

  it('handles literal percent and mixed text', async () => {
    expect(await render('100%%', fs())).toBe('100%')
    expect(await render('size=%s type=%F', fs({ size: 6 }))).toBe('size=6 type=regular file')
  })

  it('reports missing operand', async () => {
    const result = await statGeneric([], opts('%n'), () => Promise.resolve(fs()))
    if (result === null) throw new Error('statGeneric returned null')
    const [, io] = result
    expect(io.exitCode).toBe(1)
    expect(DEC.decode(await materialize(io.stderr))).toContain('missing operand')
  })

  it('continues past an errored operand and exits 1', async () => {
    const ok = PathSpec.fromStrPath('/data/ok.txt')
    const bad = PathSpec.fromStrPath('/data/bad.txt')
    const statFn = (p: PathSpec): Promise<FileStat> =>
      p.virtual === bad.virtual
        ? Promise.reject(Object.assign(new Error('nope'), { code: 'ENOENT' }))
        : Promise.resolve(fs({ size: 3 }))
    const result = await statGeneric([bad, ok], opts('%s'), statFn)
    if (result === null) throw new Error('statGeneric returned null')
    const [out, io] = result
    expect(io.exitCode).toBe(1)
    expect(DEC.decode(await materialize(out))).toBe('3\n')
  })
})

describe('stat -c workspace integration', () => {
  it('reflects overlay chmod/chown on a setattr-less backend', async () => {
    const parser = await getTestParser()
    const resource = new RAMResource()
    resource.store.files.set('/f.txt', new TextEncoder().encode('hello'))
    const ws = new Workspace(
      { '/data': resource },
      { mode: MountMode.WRITE, shellParser: parser, ops: new NoSetattrRegistry() },
    )
    await run(ws, 'chmod 600 /data/f.txt')
    await run(ws, 'chown 501:staff /data/f.txt')
    const [code, out] = await run(ws, 'stat -c "%a %u %g" /data/f.txt')
    expect(code).toBe(0)
    expect(out).toBe('600 501 staff\n')
  })

  it('defaults owner to the workspace agent', async () => {
    const parser = await getTestParser()
    const resource = new RAMResource()
    resource.store.files.set('/f.txt', new TextEncoder().encode('hello'))
    const ws = new Workspace(
      { '/data': resource },
      { mode: MountMode.WRITE, shellParser: parser, agentId: 'agent7' },
    )
    const [code, out] = await run(ws, 'stat -c "%U:%G" /data/f.txt')
    expect(code).toBe(0)
    expect(out).toBe('agent7:agent7\n')
  })

  it('falls back to "user" when the workspace is unclaimed', async () => {
    const parser = await getTestParser()
    const resource = new RAMResource()
    resource.store.files.set('/f.txt', new TextEncoder().encode('hello'))
    const ws = new Workspace({ '/data': resource }, { mode: MountMode.WRITE, shellParser: parser })
    const [code, out] = await run(ws, 'stat -c "%U:%G" /data/f.txt')
    expect(code).toBe(0)
    expect(out).toBe('user:user\n')
  })

  it('agrees with ls -l on owner', async () => {
    const parser = await getTestParser()
    const resource = new RAMResource()
    resource.store.files.set('/f.txt', new TextEncoder().encode('hello'))
    const ws = new Workspace(
      { '/data': resource },
      { mode: MountMode.WRITE, shellParser: parser, agentId: 'agent7' },
    )
    const [, statOwner] = await run(ws, 'stat -c "%U %G" /data/f.txt')
    const [, lsLong] = await run(ws, 'ls -l /data/f.txt')
    expect(statOwner.trim()).toBe('agent7 agent7')
    expect(lsLong).toContain('agent7 agent7')
  })
})
