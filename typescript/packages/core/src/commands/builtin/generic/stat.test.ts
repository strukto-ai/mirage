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
import { parseSessionProfile } from '../../../policy/profile.ts'
import { RAMResource } from '../../../resource/ram/ram.ts'
import { type CommandOpts } from '../../config.ts'
import {
  ContentType,
  DEVICE_NUMBERS_KEY,
  FileStat,
  type FileStatInit,
  FileType,
  LINK_TARGET_KEY,
  MountMode,
  PathSpec,
} from '../../../types.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { statGeneric } from './stat.ts'

const MTIME = '2026-01-02T15:30:45Z'
const MTIME_EPOCH = '1767367845'
const DEC = new TextDecoder()

function fs(overrides: Partial<FileStatInit> = {}): FileStat {
  // A content shape rides only on a regular file; an override that picks
  // another kind drops it, the way a backend never reports one for a
  // directory or link.
  const type = overrides.type ?? FileType.FILE
  return new FileStat({
    name: 'f.txt',
    size: 6,
    modified: MTIME,
    type,
    ...(type === FileType.FILE ? { content: ContentType.TEXT } : {}),
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

function linkFs(target: string): FileStat {
  return fs({ type: FileType.SYMLINK, extra: { [LINK_TARGET_KEY]: target } })
}

// Pinned against GNU coreutils 9.7 on debian:stable-slim. Single quotes are
// the rule; a name whose only awkward character is an apostrophe reads better
// in double quotes and GNU renders that one case that way, but any other shell
// character (or an unprintable one) sends it back to single quotes. mirage
// paths are text rather than bytes, so a non-ASCII name stays literal the way
// GNU renders it in a UTF-8 locale instead of the octal bytes it emits under
// LC_ALL=C.
const GNU_QUOTED: [string, string][] = [
  ['/data/f.txt', "'/data/f.txt'"],
  ['a$b', "'a$b'"],
  ['a"b', "'a\"b'"],
  ["a'b", '"a\'b"'],
  ["a'b c", '"a\'b c"'],
  ["a'b$c", "'a'\\''b$c'"],
  ["a'b`c", "'a'\\''b`c'"],
  ["a'b\\c", "'a'\\''b\\c'"],
  ['a\'b"c', "'a'\\''b\"c'"],
  ["a'b!c", "'a'\\''b!c'"],
  // # and ~ count as special only away from the front.
  ["#a'b", '"#a\'b"'],
  ["~a'b", '"~a\'b"'],
  ["a#'b", "'a#'\\''b'"],
  ["$a'b", "'$a'\\''b'"],
  ['a\tb', "'a'$'\\t''b'"],
  ['a\nb', "'a'$'\\n''b'"],
  ['a\x07b', "'a'$'\\a''b'"],
  ['a\x01b', "'a'$'\\001''b'"],
  ['a\x1bb', "'a'$'\\033''b'"],
  ['a\x7fb', "'a'$'\\177''b'"],
  // A leading escape keeps the empty quotes; a trailing one does not.
  ['\ta', "''$'\\t''a'"],
  ['a\t', "'a'$'\\t'"],
  ['a\t\nb', "'a'$'\\t\\n''b'"],
  ["a'b\tc", "'a'\\''b'$'\\t''c'"],
  ['café', "'café'"],
  ["a'béc", '"a\'béc"'],
]

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

  it.each(GNU_QUOTED)('shell-quotes %N safely: %j', async (name, quoted) => {
    expect(await renderNamed('%N', name)).toBe(quoted + '\n')
  })

  it('quotes a link target by the same rule', async () => {
    expect(await render('%N', linkFs("a'b$c"))).toBe("'/data/f.txt' -> 'a'\\''b$c'")
    expect(await render('%N', linkFs("a'b"))).toBe("'/data/f.txt' -> \"a'b\"")
    expect(await render('%N', linkFs('a\tb'))).toBe("'/data/f.txt' -> 'a'$'\\t''b'")
  })

  it('renders owner directives, falling back to "-"', async () => {
    const owned = fs({ uid: 1000, gid: 'dev' })
    expect(await render('%u %U %g %G', owned)).toBe('1000 1000 dev dev')
    expect(await render('%u %U %g %G', fs({ uid: null, gid: null }))).toBe('- - - -')
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

  it('renders character-device number directives', async () => {
    const device = fs({
      type: FileType.CHAR_DEVICE,
      extra: { [DEVICE_NUMBERS_KEY]: [1, 3] },
    })
    expect(await render('%r %R %t %T %Hr %Lr', device)).toBe('259 103 1 3 1 3')
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

  it('handles long incomplete directives in linear time', async () => {
    const fmt = `%${'0'.repeat(10_000)}!`
    expect(await render(fmt, fs())).toBe(fmt)
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
    // The owner is the workspace user; the group is the session's
    // profile, and this session runs under none.
    expect(out).toBe('agent7:-\n')
  })

  it('renders the group as the session profile', async () => {
    const parser = await getTestParser()
    const resource = new RAMResource()
    resource.store.files.set('/f.txt', new TextEncoder().encode('hello'))
    const ws = new Workspace(
      { '/data': resource },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        agentId: 'agent7',
        profiles: { admin: parseSessionProfile({}) },
        profile: 'admin',
      },
    )
    const [code, out] = await run(ws, 'stat -c "%U:%G" /data/f.txt')
    expect(code).toBe(0)
    expect(out).toBe('agent7:admin\n')
  })

  it('falls back to "-" when the workspace is unclaimed', async () => {
    const parser = await getTestParser()
    const resource = new RAMResource()
    resource.store.files.set('/f.txt', new TextEncoder().encode('hello'))
    const ws = new Workspace({ '/data': resource }, { mode: MountMode.WRITE, shellParser: parser })
    const [code, out] = await run(ws, 'stat -c "%U:%G" /data/f.txt')
    expect(code).toBe(0)
    expect(out).toBe('-:-\n')
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
    expect(statOwner.trim()).toBe('agent7 -')
    expect(lsLong).toContain(' 1 agent7 - ')
  })
})
