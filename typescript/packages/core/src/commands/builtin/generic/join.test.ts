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
import { MountMode } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { CheckOrder, parseFlags, type JoinFlags } from './join.ts'

type Row = [string, string, string, string, string, number, string, string]

// Each row is GNU join 9.7 (debian:stable-slim) run on files a and b; every
// string is a byte view, one character per byte. Mirrors GNU in test_join.py.
const GNU: Row[] = [
  ['v1v2', '1 a\n2 b\n3 c\n', '1 x\n3 z\n4 w\n', 'join -v1 -v2 a b', '', 0, '2 b\n4 w\n', ''],
  [
    'unsorted_task',
    'b one\na two\n',
    'a x\nb y\n',
    'join a b',
    '',
    1,
    'b one y\n',
    'join: a:2: is not sorted: a two\njoin: input is not in sorted order\n',
  ],
]

function bytes(view: string): Uint8Array {
  return Uint8Array.from(view, (ch) => ch.charCodeAt(0))
}

function view(raw: Uint8Array): string {
  return String.fromCharCode(...raw)
}

async function shell(
  mounts: Record<string, Record<string, string>>,
  cmd: string,
  stdin: string,
): Promise<[number, string, string]> {
  const vfs: Record<string, RAMVFS> = {}
  for (const [prefix, files] of Object.entries(mounts)) {
    const ram = new RAMVFS()
    for (const [name, body] of Object.entries(files)) ram.store.files.set(name, bytes(body))
    vfs[prefix] = ram
  }
  const ws = new Workspace(vfs, { mode: MountMode.WRITE, shellParser: await getTestParser() })
  try {
    const io = await ws.shell(cmd, { stdin: stdin === '' ? null : bytes(stdin), cwd: '/data' })
    return [io.exitCode, view(io.stdout), view(io.stderr)]
  } finally {
    await ws.close()
  }
}

describe('join matches GNU', () => {
  it.each(GNU)('%s', async (_id, a, b, cmd, stdin, code, stdout, stderr) => {
    expect(await shell({ '/data/': { '/a': a, '/b': b } }, cmd, stdin)).toEqual([
      code,
      stdout,
      stderr,
    ])
  })
})

const DEFAULTS: JoinFlags = {
  field1: 0,
  field2: 0,
  tab: null,
  outputSeparator: ' ',
  unpairables1: false,
  unpairables2: false,
  pairables: true,
  emptyFiller: null,
  outlist: [],
  autoformat: false,
  ignoreCase: false,
  eol: '\n',
  checkOrder: CheckOrder.DEFAULT,
  header: false,
  files: [0, 1],
}

describe('parseFlags', () => {
  it.each<[Record<string, string | boolean>, Partial<JoinFlags>]>([
    [{}, {}],
    [
      { a: '2', v: '1' },
      { unpairables1: true, unpairables2: true, pairables: false },
    ],
    [{ j: '3' }, { field1: 2, field2: 2 }],
    [{ t: '' }, { tab: '\n', outputSeparator: ' ' }],
    [{ t: '\\0' }, { tab: '\0', outputSeparator: '\0' }],
    [
      { o: '0,2.3 1.1' },
      {
        outlist: [
          [0, 0],
          [2, 2],
          [1, 0],
        ],
      },
    ],
    [
      { o: 'auto', zero_terminated: true },
      { autoformat: true, eol: '\0' },
    ],
    [{ nocheck_order: true }, { checkOrder: CheckOrder.DISABLED }],
  ])('%j', (flags, expected) => {
    expect(parseFlags(flags)).toEqual({ ...DEFAULTS, ...expected })
  })
})

describe('join across mounts', () => {
  it('reads every flag through the relay', async () => {
    const r = await shell(
      { '/data/': { '/a': 'B 2\nx 1\n' }, '/data2/': { '/b': 'b y\nC z\n' } },
      'join -i -j 1 -a1 -a2 -e - -o 0,1.2,2.2 --nocheck-order /data/a /data2/b',
      '',
    )
    expect(r).toEqual([0, 'B 2 y\nC - z\nx 1 -\n', ''])
  })
})
