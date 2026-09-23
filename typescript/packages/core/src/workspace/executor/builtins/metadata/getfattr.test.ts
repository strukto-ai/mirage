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
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { MountMode } from '../../../../types.ts'
import { getTestParser } from '../../../fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace.ts'
import { encodeValue } from './getfattr.ts'

// Every expectation below is what Debian's attr 2.5.2 printed for the same
// line in docker (debian:stable-slim). Mirrors python's test_getfattr.py.
const USAGE =
  'Usage: getfattr [-hRLP] [-n name|-d] [-e en] [-m pattern] path...\n' +
  "Try `getfattr --help' for more information.\n"
const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function seeded(): Promise<Workspace> {
  const parser = await getTestParser()
  const ws = new Workspace({ '/r': new RAMVFS() }, { mode: MountMode.WRITE, shellParser: parser })
  await ws.shell('mkdir /r/d && echo hi > /r/d/f && ln -s f /r/d/l')
  await ws.vfs.setxattr('/r/d/f', 'user.b', ENC.encode('two'))
  await ws.vfs.setxattr('/r/d/f', 'user.a', ENC.encode('one'))
  await ws.vfs.setxattr('/r/d/f', 'user.nl', ENC.encode('a\nb'))
  await ws.vfs.setxattr('/r/d/f', 'trusted.t', ENC.encode('tee'))
  return ws
}

async function run(ws: Workspace, line: string): Promise<[number, string, string]> {
  const r = await ws.shell(`cd /r && ${line}`)
  return [r.exitCode, r.stdoutText, r.stderrText]
}

describe('encodeValue matches getfattr', () => {
  const bytes = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0))
  it.each([
    ['one', null, '"one"'],
    ['', null, '""'],
    ['a\nb', null, '0sYQpi'],
    ['a\nb', 'text', '"a\\012b"'],
    ['\nabcdefg', null, '"\\012abcdefg"'],
    ['abc\0', null, '"abc"'],
    ['"q"\\', null, '"\\"q\\"\\\\"'],
    ['caf\xc3\xa9', null, '0sY2Fmw6k='],
    ['hi', 'hex', '0x6869'],
    ['', 'base64', '0s'],
  ])('%j with %s', (value, encoding, shown) => {
    expect(DEC.decode(encodeValue(bytes(value), encoding))).toBe(shown)
  })
})

describe('getfattr', () => {
  it('lists names sorted under a file header', async () => {
    expect(await run(await seeded(), 'getfattr d/f')).toEqual([
      0,
      '# file: d/f\nuser.a\nuser.b\nuser.nl\n\n',
      '',
    ])
  })

  it('dumps values and hides other namespaces by default', async () => {
    const ws = await seeded()
    const [, out] = await run(ws, 'getfattr -d d/f')
    expect(out).toBe('# file: d/f\nuser.a="one"\nuser.b="two"\nuser.nl=0sYQpi\n\n')
    const [, every] = await run(ws, 'getfattr -d -m - d/f')
    expect(every).toContain('trusted.t="tee"')
    const [, empty] = await run(ws, "getfattr -m '' d/f")
    expect(empty).toContain('trusted.t\n')
  })

  it('reads one name, and bare values', async () => {
    const ws = await seeded()
    expect((await run(ws, 'getfattr -n user.a -e hex d/f'))[1]).toBe(
      '# file: d/f\nuser.a=0x6f6e65\n\n',
    )
    expect((await run(ws, 'getfattr -n user.a --only-values d/f'))[1]).toBe('one')
  })

  it('reports a missing attribute and a missing file', async () => {
    const ws = await seeded()
    expect(await run(ws, 'getfattr -n user.zz d/f')).toEqual([
      1,
      '',
      'd/f: user.zz: No such attribute\n',
    ])
    expect(await run(ws, 'getfattr -d d/nope')).toEqual([
      1,
      '',
      'getfattr: d/nope: No such file or directory\n',
    ])
  })

  it('reads a link itself under -h', async () => {
    const ws = await seeded()
    expect((await run(ws, 'getfattr -n user.a d/l'))[1]).toBe('# file: d/l\nuser.a="one"\n\n')
    expect(await run(ws, 'getfattr -d -h d/l')).toEqual([0, '', ''])
  })

  it('strips a leading slash from the header, not from messages', async () => {
    const ws = await seeded()
    expect(await run(ws, 'getfattr -n user.a /r/d/f')).toEqual([
      0,
      '# file: r/d/f\nuser.a="one"\n\n',
      "getfattr: Removing leading '/' from absolute path names\n",
    ])
    expect((await run(ws, 'getfattr -n user.a --absolute-names /r/d/f'))[1]).toMatch(
      /^# file: \/r\/d\/f\n/,
    )
    expect(await run(ws, 'getfattr -n user.zz /r/d/f')).toEqual([
      1,
      '',
      '/r/d/f: user.zz: No such attribute\n',
    ])
  })

  it('walks a tree, reporting links without descending', async () => {
    expect((await run(await seeded(), 'getfattr -R -n user.b d'))[1]).toBe(
      '# file: d/f\nuser.b="two"\n\n# file: d/l\nuser.b="two"\n\n',
    )
  })

  it.each([
    ['getfattr', ''],
    ['getfattr -Z d/f', "getfattr: invalid option -- 'Z'\n"],
    ['getfattr -n', "getfattr: option requires an argument -- 'n'\n"],
    ['getfattr -e bogus -d d/f', ''],
  ])('%s is a usage error', async (line, first) => {
    expect(await run(await seeded(), line)).toEqual([2, '', first + USAGE])
  })

  it('refuses a bad match pattern', async () => {
    expect(await run(await seeded(), "getfattr -m '[' -d d/f")).toEqual([
      1,
      '',
      'getfattr: invalid regular expression "["\n',
    ])
  })
})
