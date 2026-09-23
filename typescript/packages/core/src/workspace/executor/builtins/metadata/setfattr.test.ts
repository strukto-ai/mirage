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
import { decodeValue } from './setfattr.ts'

// Every expectation below is what Debian's attr 2.5.2 did for the same
// line in docker (debian:stable-slim). Mirrors python's test_setfattr.py.
const USAGE =
  'Usage: setfattr {-n name} [-v value] [-h] file...\n' +
  '       setfattr {-x name} [-h] file...\n' +
  "Try `setfattr --help' for more information.\n"
const DEC = new TextDecoder()

async function open(): Promise<Workspace> {
  const parser = await getTestParser()
  const ws = new Workspace({ '/r': new RAMVFS() }, { mode: MountMode.WRITE, shellParser: parser })
  await ws.shell('echo hi > /r/f && ln -s f /r/l')
  return ws
}

async function run(ws: Workspace, line: string): Promise<[number, string]> {
  const r = await ws.shell(`cd /r && ${line}`)
  return [r.exitCode, r.stderrText]
}

describe('decodeValue matches setfattr', () => {
  it.each([
    ['two', 'two'],
    ['0x6869', 'hi'],
    ['0X6869', 'hi'],
    ['0saGk=', 'hi'],
    ['0S aGk=', 'hi'],
    ['"q v"', 'q v'],
    ['"a\\"b"', 'a"b'],
    ['a\\\\b', 'a\\b'],
    ['a\\012b', 'a\nb'],
    ['\\141', 'a'],
    ['a\\qb', 'a\\qb'],
    ['"unterminated', '"unterminated'],
    ['0x', '0x'],
  ])('%s stores %j', (typed, stored) => {
    const value = decodeValue(typed)
    expect(value === null ? null : DEC.decode(value)).toBe(stored)
  })

  it.each(['0x6', '0xzz', '0s!!!'])('%s is refused', (typed) => {
    expect(decodeValue(typed)).toBeNull()
  })
})

describe('setfattr', () => {
  it('sets then removes', async () => {
    const ws = await open()
    expect(await run(ws, 'setfattr -n user.a -v one f')).toEqual([0, ''])
    expect(DEC.decode(await ws.vfs.getxattr('/r/f', 'user.a'))).toBe('one')
    expect(await run(ws, 'setfattr -n user.empty f')).toEqual([0, ''])
    expect((await ws.vfs.getxattr('/r/f', 'user.empty')).byteLength).toBe(0)
    expect(await run(ws, 'setfattr -x user.a f')).toEqual([0, ''])
    expect(await run(ws, 'setfattr -x user.a f')).toEqual([1, 'setfattr: f: No such attribute\n'])
  })

  it('writes the link itself under -h', async () => {
    const ws = await open()
    expect(await run(ws, 'setfattr -h -n user.own -v o l')).toEqual([0, ''])
    expect(await ws.vfs.listxattr('/r/l', { nofollow: true })).toEqual(['user.own'])
    expect(await ws.vfs.listxattr('/r/f')).toEqual([])
  })

  it('reports a missing file and writes the rest', async () => {
    const ws = await open()
    expect(await run(ws, 'setfattr -n user.a -v 1 nope f')).toEqual([
      1,
      'setfattr: nope: No such file or directory\n',
    ])
    expect(DEC.decode(await ws.vfs.getxattr('/r/f', 'user.a'))).toBe('1')
  })

  it('refuses a malformed encoding', async () => {
    expect(await run(await open(), 'setfattr -n user.a -v 0x6 f')).toEqual([
      1,
      'bad input encoding\n',
    ])
  })

  it.each([
    ['setfattr f', ''],
    ['setfattr -n user.a -x user.b f', ''],
    ['setfattr -x user.a -v q f', ''],
    ['setfattr -n user.a', ''],
    ['setfattr -n user.a -v', "setfattr: option requires an argument -- 'v'\n"],
  ])('%s is a usage error', async (line, first) => {
    expect(await run(await open(), line)).toEqual([2, first + USAGE])
  })
})
