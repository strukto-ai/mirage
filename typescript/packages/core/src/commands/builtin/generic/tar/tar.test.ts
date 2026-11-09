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

// Mirrors python/tests/commands/builtin/generic/tar/test_tar.py.

import { expect, it } from 'vitest'
import { MountMode } from '../../../../types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'

const DEC = new TextDecoder()

async function shell(
  line: string,
  seed: Record<string, Uint8Array>,
): Promise<[number, string, string]> {
  const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
  try {
    for (const [path, data] of Object.entries(seed)) {
      await ws.shell(`tee ${path} > /dev/null`, { stdin: data })
    }
    const io = await ws.shell(line)
    return [io.exitCode, DEC.decode(io.stdout), DEC.decode(io.stderr)]
  } finally {
    await ws.close()
  }
}

it('lists the member a cut short stream reaches', async () => {
  // The stream holds the first header and no data block: GNU lists the
  // member it reached, then stops there without its child's status (tar
  // 1.35, same bytes).
  const cut = new Uint8Array([
    31, 139, 8, 0, 0, 0, 0, 0, 0, 19, 75, 209, 79, 212, 43, 169, 40, 97, 160, 37, 48, 0, 2, 51, 19,
    19, 48, 13, 4, 232, 52, 72, 22, 137, 13, 18, 55, 55, 52, 49, 101, 80, 48, 160, 169, 171, 160,
    160, 180, 184, 36, 177, 8, 104, 37, 61, 236, 26, 132, 32, 35, 53, 39, 39, 159, 107, 160, 93, 49,
    10, 6,
  ])
  const r = await shell('tar -tzf /data/cut.tgz', { '/data/cut.tgz': cut })
  expect(r).toEqual([
    2,
    'd/a.txt\n',
    '\ngzip: stdin: unexpected end of file\n' +
      'tar: Unexpected EOF in archive\n' +
      'tar: Error is not recoverable: exiting now\n',
  ])
})

it('streams an archive without a writable root or a dash file', async () => {
  const ws = new Workspace(
    { '/data': [new RAMVFS(), MountMode.WRITE] },
    {
      mode: MountMode.READ,
    },
  )
  await ws.shell('printf hello > /data/a')
  const result = await ws.shell('tar -cvf - -C /data a | tar -xOf -')
  expect(result.exitCode).toBe(0)
  expect(DEC.decode(result.stdout)).toBe('hello')
  expect(DEC.decode(result.stderr)).toBe('a\n')
  expect((await ws.shell('test ! -e /-')).exitCode).toBe(0)
  await ws.close()
})

const SEEDED = "cd /data && printf '1\\n' > a; printf '2\\n' > b; "

const ROWS: [string, string, [number, string, string]][] = [
  [
    'names_lists',
    "printf 'a\\n\\nb\\n' > l; printf 'a\\0b\\0' > n; tar -cf o.tar -T l; tar -tf o.tar; tar -cf n.tar --null -T n; tar -tf n.tar",
    [0, 'a\nb\na\nb\n', ''],
  ],
  ['exclude_list', "printf 'a\\n' > x; tar -cf o.tar -X x a b; tar -tf o.tar", [0, 'b\n', '']],
  [
    'unreadable_exclude_list',
    'tar -cf o.tar -X nope a; echo rc=$?; wc -c < o.tar',
    [
      0,
      'rc=2\n0\n',
      'tar: nope: No such file or directory\ntar: Error is not recoverable: exiting now\n',
    ],
  ],
  ['codec_from_suffix', 'tar -caf o.tgz a; tar -tzf o.tgz', [0, 'a\n', '']],
  [
    'records_time_and_mode',
    "touch -d 2001-02-03T04:05:06Z a; chmod 640 a; tar -cf o.tar a; tar -tvf o.tar | cut -c1-10; tar -tvf o.tar | grep -c '2001-02-03 04:05 a'; tar --mtime=@0 -cf m.tar a; tar -tvf m.tar | grep -c '1970-01-01 00:00 a'",
    [0, '-rw-r-----\n1\n1\n', ''],
  ],
  [
    'append_and_delete',
    'tar -cf o.tar a; tar -rf o.tar b; tar -tf o.tar; tar --delete -f o.tar a; tar -tf o.tar',
    [0, 'a\nb\nb\n', ''],
  ],
  [
    'keep_and_skip_old_files',
    'tar -cf o.tar a; echo KEEP > a; tar -xkf o.tar; echo rc=$?; cat a; tar --skip-old-files -xf o.tar; echo rc=$?; cat a',
    [
      0,
      'rc=2\nKEEP\nrc=0\nKEEP\n',
      'tar: a: Cannot open: File exists\ntar: Exiting with failure status due to previous errors\n',
    ],
  ],
  [
    'transform',
    'tar -cf o.tar a; mkdir o; tar -C o --transform=s/a/z/ -xf o.tar; ls o',
    [0, 'z\n', ''],
  ],
  [
    'exclude_vcs',
    'mkdir .git; echo 1 > .git/c; tar --exclude-vcs -cf o.tar .git a; tar -tf o.tar',
    [0, 'a\n', ''],
  ],
]

it.each(ROWS)('tar option %s', async (_name, line, expected) => {
  expect(await shell(SEEDED + line, {})).toEqual(expected)
})
