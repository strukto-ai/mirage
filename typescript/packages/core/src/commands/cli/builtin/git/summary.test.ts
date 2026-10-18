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
import { encodeText } from '../../../../shell/bytes.ts'
import { statTable, type FileStat } from './summary.ts'

const stat = (
  path: string,
  insertions: number,
  deletions: number,
  binary = false,
  oldSize = 0,
  newSize = 0,
): FileStat => ({ path, insertions, deletions, binary, oldSize, newSize })

const render = (stats: readonly FileStat[], width?: number): string =>
  statTable(stats, width)
    .map((row) => `${row}\n`)
    .join('')

describe('statTable', () => {
  // The geometry rows pinned against git 2.50.1 (scratch repo, piped output):
  // scaling at 21 graph columns, left elision at a component boundary, the bare
  // `| 0` mode-only row, and the Bin byte report.
  it("matches git's scaled layout", () => {
    expect(
      statTable([
        stat('bin.dat', 0, 0, true, 0, 100),
        stat('deep/nested/dir/structure/a_rather_long_file_name_here.txt', 150, 0),
        stat('new.txt', 3, 0),
        stat('small.txt', 195, 0),
        stat('tiny.txt', 0, 1),
      ]),
    ).toEqual([
      ' bin.dat                                            | Bin 0 -> 100 bytes',
      ' .../dir/structure/a_rather_long_file_name_here.txt | 150 ++++++++++++++++',
      ' new.txt                                            |   3 +',
      ' small.txt                                          | 195 +++++++++++++++++++++',
      ' tiny.txt                                           |   1 -',
      ' 5 files changed, 348 insertions(+), 1 deletion(-)',
    ])
  })

  it('leaves a graph unscaled when it fits', () => {
    expect(statTable([stat('a.txt', 1, 1)])).toEqual([
      ' a.txt | 2 +-',
      ' 1 file changed, 1 insertion(+), 1 deletion(-)',
    ])
  })

  it('keeps the bytes of a cut character', () => {
    // git 2.47.3, core.quotePath=false: a name of 40 wide characters cut 11
    // bytes in starts with the last byte of the 4th, kept as it is. Mirrors
    // test_summary.py.
    const [row] = statTable([stat('\u754c'.repeat(40), 1, 0)])
    expect(row).toBe(` ...\udc8c${'\u754c'.repeat(36)} | 1 +`)
    expect(Array.from(encodeText(row ?? '').subarray(0, 8))).toEqual([
      0x20, 0x2e, 0x2e, 0x2e, 0x8c, 0xe7, 0x95, 0x8c,
    ])
  })

  it('gives a mode-only row no graph', () => {
    expect(statTable([stat('new.txt', 0, 0)])).toEqual([
      ' new.txt | 0',
      ' 1 file changed, 0 insertions(+), 0 deletions(-)',
    ])
  })

  it('prints nothing for no paths', () => {
    expect(statTable([])).toEqual([])
  })

  // Tables measured with git 2.50.1 and 2.47.3 (`git diff --stat=<width>`,
  // piped): each case's stats and what git prints at each width.
  const probes: Record<string, [FileStat[], Record<number, string>]> = {
    // graphs scaled into a narrow share, the smaller side first
    scaled: [
      [
        stat('apefca_/ivayfzwv/l/xuc/iw', 99, 1),
        stat('mgd_kybwafn/kciklieqza-/prpokhw_lq/qkafb', 53, 33),
        stat('vzgyn/ytbi-ql/usunncxtsgw', 5, 3),
      ],
      {
        40: ' apefca_/ivayfzwv/l/xuc/iw | 100 +++++-\n .../prpokhw_lq/qkafb      |  86 +++--\n vzgyn/ytbi-ql/usunncxtsgw |   8 +-\n 3 files changed, 157 insertions(+), 37 deletions(-)\n',
        80: ' apefca_/ivayfzwv/l/xuc/iw                | 100 ++++++++++++++++++++++++++++++-\n mgd_kybwafn/kciklieqza-/prpokhw_lq/qkafb |  86 ++++++++++++++++----------\n vzgyn/ytbi-ql/usunncxtsgw                |   8 ++-\n 3 files changed, 157 insertions(+), 37 deletions(-)\n',
      },
    ],
    // a binary row widening the count column and claiming graph room
    binary: [
      [
        stat('ffqhaygr-rh/ql-sloi/rtxamz-_xqz/qyr/nbp-/srgqnp/lnlarrt', 9999, 10000),
        stat(
          'zycidpyopumzgd/a_mntyya/oixzhsdkaaau/amvgnxaqh/oprhlhvhyojan/rudfux-jdxkxwq/q_vgjjs/-qms-bph/zmnvflrwyvxl/ov/dyfq_mlpx/p',
          0,
          0,
          true,
          4859,
          4736,
        ),
      ],
      {
        80: ' .../ql-sloi/rtxamz-_xqz/qyr/nbp-/srgqnp/lnlarrt    | 19999 +++++++++----------\n .../q_vgjjs/-qms-bph/zmnvflrwyvxl/ov/dyfq_mlpx/p   |   Bin 4859 -> 4736 bytes\n 2 files changed, 9999 insertions(+), 10000 deletions(-)\n',
        40: ' .../nbp-/srgqnp/lnlarrt | 19999 +++---\n .../ov/dyfq_mlpx/p      |   Bin 4859 -> 4736 bytes\n 2 files changed, 9999 insertions(+), 10000 deletions(-)\n',
      },
    ],
    // a long name with a small change, at and under the narrowest table
    small: [
      [stat('abcdefghij/klmnopqrst/uvwxyzabcd/efghijklmn/opqrstuvwx', 3, 0)],
      {
        26: ' ...opqrstuvwx | 3 +++\n 1 file changed, 3 insertions(+)\n',
        27: ' .../opqrstuvwx    | 3 +++\n 1 file changed, 3 insertions(+)\n',
        20: ' ...rstuvwx | 3 +++\n 1 file changed, 3 insertions(+)\n',
      },
    ],
    // wide characters cut by bytes and padded by columns, renames cut like any path
    wide: [
      [
        stat('abc/中文名字/x.txt', 2, 0),
        stat('keep/same/dir/{oldname.txt => newname.txt}', 0, 0),
        stat('nodirectorybutaverylongfilenamewithoutanyslashesatallreallylong.txt', 11, 0),
        stat('plain/without/any/wide/characters/at/all/in/this/path/name.txt', 0, 6),
        stat('ren/{old/place => new/spot}/file.txt', 0, 0),
        stat('目录/子目录/非常长的文件名字在这里/文件一.txt', 10, 0),
      ],
      {
        40: ' abc/中文名字/x.txt        |  2 ++\n ...me.txt => newname.txt} |  0\n ...hesatallreallylong.txt | 11 +++++++\n .../in/this/path/name.txt |  6 ----\n .../spot}/file.txt        |  0\n .../文件一.txt            | 10 ++++++\n 6 files changed, 23 insertions(+), 6 deletions(-)\n',
        50: ' abc/中文名字/x.txt               |  2 ++\n .../{oldname.txt => newname.txt} |  0\n ...anyslashesatallreallylong.txt | 11 ++++++++++\n .../at/all/in/this/path/name.txt |  6 -----\n .../place => new/spot}/file.txt  |  0\n .../非常长的文件名字在这里/文件一.txt | 10 +++++++++\n 6 files changed, 23 insertions(+), 6 deletions(-)\n',
      },
    ],
  }
  it.each(
    Object.entries(probes).flatMap(([name, [stats, outs]]) =>
      Object.entries(outs).map(([width, out]) => [name, Number(width), stats, out] as const),
    ),
  )('lays out %s at width %i as git measures', (_name, width, stats, out) => {
    expect(render(stats, width)).toBe(out)
  })
})
