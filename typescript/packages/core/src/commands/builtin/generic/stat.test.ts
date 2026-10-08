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
import { IOResult, materialize } from '../../../io/types.ts'
import { BaseVFS } from '../../../vfs/base.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { type CommandOpts } from '../../config.ts'
import {
  CapacityState,
  ContentType,
  DEVICE_NUMBERS_KEY,
  FileStat,
  type FileStatInit,
  FileType,
  LINK_TARGET_KEY,
  MountMode,
  PathSpec,
} from '../../../types.ts'
import { DIR_SIZE } from '../../../utils/stat_view.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { statGeneric } from './stat.ts'

const MTIME = '2026-01-02T15:30:45Z'
const MTIME_SHOWN = '2026-01-02 15:30:45.000000000 +0000'
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
    flags: { format: fmt },
    filetypeFns: null,
    cwd: '/',
    vfs: null,
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

// Pinned against GNU coreutils 9.7 on debian:stable-slim under LC_ALL=C.
// Single quotes are the rule; a name whose only awkward character is an
// apostrophe reads better in double quotes and GNU renders that one case that
// way, but any other shell character (or an unprintable one, a byte past
// ASCII included) sends it back to single quotes. Mirrors test_stat.py.
const GNU_QUOTED: [string, string][] = [
  ["a'b", '"a\'b"'],
  ["a'b$c", "'a'\\''b$c'"],
  ['a\tb', "'a'$'\\t''b'"],
  // A leading escape keeps the empty quotes; a trailing one does not.
  ['\ta', "''$'\\t''a'"],
  ['café', "'caf'$'\\303\\251'"],
  ["a'béc", "'a'\\''b'$'\\303\\251''c'"],
]

class OverlayRAMVFS extends RAMVFS {
  static {
    // No setattr of its own, as an API backend with no attribute slot:
    // attrs land in the namespace overlay.
    Object.defineProperty(
      this.prototype,
      'setattr',
      Object.getOwnPropertyDescriptor(BaseVFS.prototype, 'setattr') ?? {},
    )
  }
}

async function run(ws: Workspace, cmd: string): Promise<[number, string, string]> {
  const r = await ws.shell(cmd)
  return [r.exitCode, r.stdoutText, r.stderrText]
}

describe('stat -c directive formatting', () => {
  // A directory is DIR_SIZE whatever the backend put in size: null for a
  // synthetic one, a subtree total for a Graph folder. A file keeps its own
  // size, None when unknown.
  it('sizes a directory in the default record as %s does', async () => {
    const plain = { ...opts(''), flags: {} } as CommandOpts
    const cases: [FileStat, string][] = [
      [fs({ type: FileType.DIRECTORY, size: null }), `  Size: ${String(DIR_SIZE)} `],
      [fs({ type: FileType.DIRECTORY, size: 123456 }), `  Size: ${String(DIR_SIZE)} `],
      [fs({ size: null }), '  Size: - '],
    ]
    for (const [s, want] of cases) {
      const result = await statGeneric([PathSpec.fromStrPath('/data/f.txt')], plain, () =>
        Promise.resolve(s),
      )
      if (result === null) throw new Error('statGeneric returned null')
      expect(result[1].exitCode).toBe(0)
      expect(DEC.decode(await materialize(result[0]))).toContain(want)
    }
  })

  // No mode is GNU's 0644 file default, as ls -l falls back to; a special bit
  // keeps the high octal digit and renders as s/S/t/T. Mirrors test_stat.py.
  it.each([
    [fs({ mode: null }), '644 -rw-r--r-- 81a4'],
    [fs({ mode: 0o4644 }), '4644 -rwSr--r-- 89a4'],
    [fs({ type: FileType.DIRECTORY, size: null, mode: null }), '755 drwxr-xr-x 41ed'],
  ])('renders the mode directives of %j', async (stat, want) => {
    expect(await render('%a %A %f', stat)).toBe(want)
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
    const s = fs({ modified: MTIME, ctime: MTIME, atime: '2026-03-04T05:06:07Z' })
    expect(await render('%y', s)).toBe(MTIME_SHOWN)
    expect(await render('%Y', s)).toBe(MTIME_EPOCH)
    expect(await render('%z', s)).toBe(MTIME_SHOWN)
    expect(await render('%Z', s)).toBe(MTIME_EPOCH)
    expect(await render('%x', s)).toBe('2026-03-04 05:06:07.000000000 +0000')
    expect(await render('%X', s)).toBe('1772600767')
  })

  it('falls back atime to mtime when absent', async () => {
    const s = fs({ modified: MTIME, ctime: MTIME, atime: null })
    expect(await render('%x', s)).toBe(MTIME_SHOWN)
    expect(await render('%X', s)).toBe(MTIME_EPOCH)
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

  it('handles long incomplete directives in linear time', async () => {
    const fmt = `%${'0'.repeat(10_000)}!`
    expect(await render(fmt, fs())).toBe('?')
  })

  it('counts a quota in 1K blocks under -f', async () => {
    const quota = {
      ...opts('%T %S %b %f %a %c %d %i %5l|'),
      flags: { format: '%T %S %b %f %a %c %d %i %5l|', file_system: true },
      dispatch: () =>
        Promise.resolve([
          [
            'disk',
            {
              state: CapacityState.QUOTA,
              total: 40960,
              used: 16384,
              available: 12288,
              inodes: 100,
              inodesUsed: 40,
              inodesFree: 50,
            },
          ],
          new IOResult(),
        ]),
    } as unknown as CommandOpts
    const result = await statGeneric([PathSpec.fromStrPath('/data/f.txt')], quota, () =>
      Promise.resolve(fs()),
    )
    const [out, io] = result ?? [null, new IOResult()]
    expect(io.exitCode).toBe(0)
    expect(DEC.decode(await materialize(out))).toBe('disk 1024 40 24 12 100 60 ?     ?|\n')
  })

  it('knows no file system under -f without a workspace', async () => {
    const bare = {
      ...opts(''),
      flags: { format: '%n %T %b %05c', file_system: true },
    } as unknown as CommandOpts
    const result = await statGeneric([PathSpec.fromStrPath('/data/f.txt')], bare, () =>
      Promise.resolve(fs()),
    )
    const [out] = result ?? [null]
    expect(DEC.decode(await materialize(out))).toBe('/data/f.txt - -     -\n')
  })

  it('reports missing operand', async () => {
    await expect(statGeneric([], opts('%n'), () => Promise.resolve(fs()))).rejects.toThrow(
      "stat: missing operand\nTry 'stat --help' for more information.",
    )
  })
})

describe('stat -c workspace integration', () => {
  it('reflects overlay chmod/chown on a setattr-less backend', async () => {
    const parser = await getTestParser()
    const vfs = new OverlayRAMVFS()
    vfs.store.files.set('/f.txt', new TextEncoder().encode('hello'))
    const ws = new Workspace({ '/data': vfs }, { mode: MountMode.WRITE, shellParser: parser })
    await run(ws, 'chmod 600 /data/f.txt')
    await run(ws, 'chown 501:staff /data/f.txt')
    const [code, out] = await run(ws, 'stat -c "%a %u %g" /data/f.txt')
    expect(code).toBe(0)
    expect(out).toBe('600 501 staff\n')
  })

  it('defaults owner to the workspace agent', async () => {
    const parser = await getTestParser()
    const vfs = new RAMVFS()
    vfs.store.files.set('/f.txt', new TextEncoder().encode('hello'))
    const ws = new Workspace(
      { '/data': vfs },
      { mode: MountMode.WRITE, shellParser: parser, agentId: 'agent7' },
    )
    const [code, out] = await run(ws, 'stat -c "%U:%G" /data/f.txt')
    expect(code).toBe(0)
    // The owner is the workspace user; the group is the session's
    // profile, and this session runs under none.
    expect(out).toBe('agent7:-\n')
  })

  it('falls back to "-" when the workspace is unclaimed', async () => {
    const parser = await getTestParser()
    const vfs = new RAMVFS()
    vfs.store.files.set('/f.txt', new TextEncoder().encode('hello'))
    const ws = new Workspace({ '/data': vfs }, { mode: MountMode.WRITE, shellParser: parser })
    const [code, out] = await run(ws, 'stat -c "%U:%G" /data/f.txt')
    expect(code).toBe(0)
    expect(out).toBe('-:-\n')
  })
})

it('renders GNU default layout with explicit unknown metadata', async () => {
  const info = fs({ size: null, modified: null, ctime: null })
  const result = await statGeneric(
    [PathSpec.fromStrPath('/data/f.txt')],
    { ...opts(''), flags: {} },
    () => Promise.resolve(info),
  )
  if (result === null) throw new Error('missing result')
  expect(DEC.decode(await materialize(result[0]))).toBe(
    '  File: /data/f.txt\n' +
      '  Size: -         \tBlocks: ?          IO Block: ?      regular file\n' +
      'Device: ?\tInode: ?           Links: ?\n' +
      'Access: (0644/-rw-r--r--)  Uid: (    -/       -)   Gid: (    -/       -)\n' +
      'Access: -\nModify: -\nChange: -\n Birth: -\n',
  )
  expect(await render('%z %Z %w %W', info)).toBe('- 0 - 0')
  expect(await render('%z %Z %w %W', fs({ ctime: '2026-03-04T05:06:07Z', birthtime: MTIME }))).toBe(
    `2026-03-04 05:06:07.000000000 +0000 1772600767 ${MTIME_SHOWN} ${MTIME_EPOCH}`,
  )
})

async function defaultLines(s: FileStat): Promise<string[]> {
  const result = await statGeneric(
    [PathSpec.fromStrPath('/data/f.txt')],
    { ...opts(''), flags: {} },
    () => Promise.resolve(s),
  )
  if (result === null) throw new Error('missing result')
  return DEC.decode(await materialize(result[0]))
    .trimEnd()
    .split('\n')
}

it("renders the directives' times in GNU layout, identically across hosts", async () => {
  // The Access line is %x, which falls back to the mtime; a naive stamp is
  // UTC and an offset one is moved to UTC; the fraction is the digits the
  // stamp carries, so both hosts print the same line.
  const lines = await defaultLines(
    fs({
      modified: '2026-03-04T05:06:07.123456789',
      ctime: '2026-03-04T07:06:07.5+02:00',
      birthtime: '2026-03-04T05:06:07Z',
    }),
  )
  expect(lines.slice(4)).toEqual([
    'Access: 2026-03-04 05:06:07.123456789 +0000',
    'Modify: 2026-03-04 05:06:07.123456789 +0000',
    'Change: 2026-03-04 05:06:07.500000000 +0000',
    ' Birth: 2026-03-04 05:06:07.000000000 +0000',
  ])
  expect((await defaultLines(fs({ modified: 'not a time' })))[5]).toBe('Modify: -')
})

it('names a device type in the default layout', async () => {
  const lines = await defaultLines(
    fs({ type: FileType.CHAR_DEVICE, size: null, extra: { [DEVICE_NUMBERS_KEY]: [1, 3] } }),
  )
  expect(lines[1]?.endsWith('character special file')).toBe(true)
  expect(lines[2]).toBe('Device: ?\tInode: ?           Links: ?     Device type: 1,3')
})
