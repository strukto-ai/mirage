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

async function run(line: string): Promise<[string, string, number]> {
  const parser = await getTestParser()
  const ram = new RAMVFS()
  const ws = new Workspace({ '/ram': ram }, { mode: MountMode.WRITE, shellParser: parser })
  try {
    const io = await ws.shell(line)
    return [io.stdoutText, io.stderrText, io.exitCode]
  } finally {
    await ws.close()
  }
}

function refusal(line: string): string {
  return `seq: ${line}\nTry 'seq --help' for more information.\n`
}

// GNU seq 9.7 on debian:stable-slim. Widths and decimals come from the
// operands as typed, a hex operand has no width, and the numbers are exact
// where GNU's long double would round. Mirrors test_seq.py.
describe('seq', () => {
  it.each([
    ['seq 0 0.1 0.5', '0.0\n0.1\n0.2\n0.3\n0.4\n0.5\n'],
    ['seq 1 0.25 2', '1.00\n1.25\n1.50\n1.75\n2.00\n'],
    ['seq .5 2', '0.5\n1.5\n'],
    ['seq 1.50 2', '1.50\n'],
    ['seq 1. 3', '1\n2\n3\n'],
    ['seq 1e1 1.2e1', '10\n11\n12\n'],
    ['seq 1.5e-1 0.05 0.3', '0.15\n0.20\n0.25\n0.30\n'],
    ['seq 0 0.000001 0.000003', '0.000000\n0.000001\n0.000002\n0.000003\n'],
    ['seq 10 -0.3 9', '10.0\n9.7\n9.4\n9.1\n'],
    ['seq 0x10 0x12', '16\n17\n18\n'],
    ['seq 1 0x1.8 5', '1\n2.5\n4\n'],
    ['seq 0x1p20 0x1p20', '1.04858e+06\n'],
    ["seq ' 1' ' 3'", '1\n2\n3\n'],
    ['seq -0 1', '-0\n1\n'],
    ['seq -0.0 1', '-0.0\n1.0\n'],
    [
      'seq 18446744073709551616 18446744073709551618',
      '18446744073709551616\n18446744073709551617\n18446744073709551618\n',
    ],
    [
      'seq -s, 99999999999999999999 100000000000000000001',
      '99999999999999999999,100000000000000000000,100000000000000000001\n',
    ],
    ['seq -w -1 1', '-1\n00\n01\n'],
    ['seq -w .5 -0.25 -.5', '00.50\n00.25\n00.00\n-0.25\n-0.50\n'],
    ['seq -w 1 0.5e1', '01\n02\n03\n04\n05\n'],
    ['seq -w 8 0x10 | head -2', '8\n9\n'],
    ['seq -w 1 0x1.8 5', '1\n2.5\n4\n'],
    ['seq -w -0 1', '-0\n01\n'],
    ['seq 2 -1', ''],
    ['seq 1 -inf 3', ''],
    ['seq 1 inf 3', '1\n'],
    ['seq 3 -inf 1', '3\n'],
    ['seq inf | head -3', '1\n2\n3\n'],
    ['seq inf -inf 1 | head -3', 'inf\nnan\nnan\n'],
    ['seq 1e-4960', ''],
    ['seq 1.1897314953572317650e4932 | head -2', '1\n2\n'],
    ['seq -f %g 1 1.0000001 2', '1\n2\n'],
    ['seq -f %.1f 0 0.34 1', '0.0\n0.3\n0.7\n1.0\n'],
    ['seq -f %.0f 0 0.6 1', '0\n1\n'],
    [
      'seq -f %.20f 0.1 0.1 0.3',
      '0.10000000000000000000\n0.20000000000000000000\n0.30000000000000000000\n',
    ],
    ["seq -f '%08.2f' -1 1", '-0001.00\n00000.00\n00001.00\n'],
    ["seq -f '%#.0f' 1 2", '1.\n2.\n'],
    ["seq -f '%G' 1e-5 1e-5", '1E-05\n'],
    ["seq -f '%-8g|' 1 2", '1       |\n2       |\n'],
    ["seq -f '% g' -1 1", '-1\n 0\n 1\n'],
    ['seq -f %g 100000 100000 1000000 | tail -2', '900000\n1e+06\n'],
    ['seq -f %a 1 0.5 2', '0x1p+0\n0x1.8p+0\n0x1p+1\n'],
    ['seq -f %a 0x1p1024 0x1p1024 | head -1', '0x1p+1024\n'],
    ['seq -f %a 0.1 0.1', '0x1.999999999999999999999999999ap-4\n'],
    ['seq -f %a 0x1p-16400 0x1p-16400', '0x0.00004p-16382\n'],
    ['seq -f %a 0x1p-16495 0x1p-16495', '0x0p+0\n'],
    ['seq -f %#a 0 0', '0x0.p+0\n'],
    ['seq 0x1p-16494', ''],
    ['seq 1.18973149535723176508e4932 | head -2', '1\n2\n'],
    ['seq -1.5 1', '-1.5\n-0.5\n0.5\n'],
    ['seq 1 -0.5 0', '1.0\n0.5\n0.0\n'],
    ['seq -s -1 3', '1-12-13\n'],
    ['seq --equal-width --separator=: 9 10', '09:10\n'],
    ['seq --format=%g 1 2', '1\n2\n'],
    ['seq 1000000 | tail -1', '1000000\n'],
  ])('%s', async (line, out) => {
    expect(await run(line)).toEqual([out, '', 0])
  })

  it.each([
    ['seq abc', refusal("invalid floating point argument: 'abc'")],
    ["seq '3 '", refusal("invalid floating point argument: '3 '")],
    ['seq 1e', refusal("invalid floating point argument: '1e'")],
    ['seq 0x', refusal("invalid floating point argument: '0x'")],
    ['seq 1e5000', refusal("invalid floating point argument: '1e5000'")],
    ['seq 0x1p16384', refusal("invalid floating point argument: '0x1p16384'")],
    [
      'seq 1.1897314953572317651e4932',
      refusal("invalid floating point argument: '1.1897314953572317651e4932'"),
    ],
    ['seq nan', refusal("invalid 'not-a-number' argument: 'nan'")],
    ['seq 1 -nan 3', refusal("invalid 'not-a-number' argument: '-nan'")],
    ['seq 1 0 x', refusal("invalid Zero increment value: '0'")],
    ['seq 1 -0 3', refusal("invalid Zero increment value: '-0'")],
    ['seq 1 -w 3', refusal("invalid floating point argument: '-w'")],
    ['seq -1 -w 1', refusal("invalid floating point argument: '-w'")],
    [
      'seq -w -f %g 1 2',
      refusal('format string may not be specified when printing equal width strings'),
    ],
    ['seq -inf', refusal("invalid option -- 'i'")],
  ])('%s refuses', async (line, err) => {
    expect(await run(line)).toEqual(['', err, 1])
  })
})
