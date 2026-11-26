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

import { expect, it } from 'vitest'
import { MountMode } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16))
}

const ENC = new TextEncoder()
const TEXT = ENC.encode('béta 2\nalpha\t1\n\ngamma 3\r\nalpha\t1\nalpha\t1')
const JSON_LINES = ENC.encode('{"a": [1, "é"], "b": null}\n{"a": 2}\n[true]')
const NUMBERS = ENC.encode('1024\n1500000\n7')
const TABLE = ENC.encode('a bb ccc\ndddd e f\n')
const BASE64 = ENC.encode('YsOpdGEgMgphbHBoYQkxCgpnYW1tYSAzDQphbHBoYQkxCmFscGhhCTE=\n')
const HEX = ENC.encode(
  '62c3a9746120320a616c70686109310a0a67616d6d6120330d0a' + '616c70686109310a616c7068610931\n',
)
const GZIP = fromHex(
  '1f8b08000000000002ff4b3abcb22451c1882b31a7202391d3908b2b3d31373751' +
    'c198172e02a501f20e8c1d29000000',
)
const BZIP2 = fromHex(
  '425a6839314159265359748d0be900000cd99400324000380030c6440000200800' +
    '20002235347a26834d0a1a698007058a9728c1d3427ae390b2201b48f557c5dc91' +
    '4e14241d2342fa40',
)
const XZ = fromHex(
  'fd377a585a000004e6d6b4460200210116000000742fe5a3e0002800215d003130' +
    'd1274307be451f0ab6bfe07f7d980d182ddacd2002efee94811039e5e109000000' +
    '00006592df128d3d043300013d29f965dc081fb6f37d010000000004595a',
)

// `data` as a stream cut at each offset, in order. A cut at either end, or
// two at one offset, yields an empty piece.
async function* splitSource(data: Uint8Array, ...cuts: number[]): AsyncGenerator<Uint8Array> {
  await Promise.resolve()
  const edges = [0, ...cuts, data.length]
  for (let i = 0; i + 1 < edges.length; i++) yield data.subarray(edges[i], edges[i + 1])
}

it.each<[string, Uint8Array]>([
  ['cat', TEXT],
  ['cat -n', TEXT],
  ['cat -A', TEXT],
  ['head -n 2', TEXT],
  ['head -c 7', TEXT],
  ['head -n -2', TEXT],
  ['tail -n 2', TEXT],
  ['tail -c 7', TEXT],
  ['tail -n +3', TEXT],
  ['sort', TEXT],
  ['sort -r', TEXT],
  ['sort -u', TEXT],
  ['sort -k2 -n', TEXT],
  ['uniq', TEXT],
  ['uniq -c', TEXT],
  ['wc', TEXT],
  ['wc -l', TEXT],
  ['wc -m', TEXT],
  ['wc -L', TEXT],
  ['cut -b 1-3', TEXT],
  ['cut -c 1-2', TEXT],
  ['cut -f 2', TEXT],
  ['tr a-z A-Z', TEXT],
  ["tr -d '\\n'", TEXT],
  ['tr -s a', TEXT],
  ['grep alpha', TEXT],
  ['grep -c alpha', TEXT],
  ['grep -vn alpha', TEXT],
  ["grep -o 'a.'", TEXT],
  ['rg alpha', TEXT],
  ['sed s/alpha/A/', TEXT],
  ['sed -n 2p', TEXT],
  ["sed '$d'", TEXT],
  ["awk '{print $2}'", TEXT],
  ["awk 'END {print NR}'", TEXT],
  ['nl', TEXT],
  ['rev', TEXT],
  ['fold -w 3', TEXT],
  ['fmt -w 12', TEXT],
  ['expand', TEXT],
  ['unexpand -a', TEXT],
  ['paste -s', TEXT],
  ['paste -d, - -', TEXT],
  ['column -t', TABLE],
  ['tee', TEXT],
  ['base64', TEXT],
  ['base64 -d', BASE64],
  ['xxd', TEXT],
  ['xxd -p', TEXT],
  ['xxd -r -p', HEX],
  ['md5sum', TEXT],
  ['sha256sum', TEXT],
  ['sha1sum', TEXT],
  ['iconv -f UTF-8 -t UTF-16LE', TEXT],
  ['iconv -f UTF-8 -t LATIN1', TEXT],
  ['numfmt --to=iec', NUMBERS],
  ['jq .', JSON_LINES],
  ['jq -c .', JSON_LINES],
  ['jq -s length', JSON_LINES],
  ['gunzip -c', GZIP],
  ['zcat', GZIP],
  ['bzip2 -dc', BZIP2],
  ['xz -dc', XZ],
  ['gzip -c | gunzip -c', TEXT],
  ['bzip2 -c | bzip2 -dc', TEXT],
  ['xz -c | xz -dc', TEXT],
])('%s output does not depend on where stdin is cut', async (line, data) => {
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
  try {
    const io = await ws.shell(line, { stdin: data })
    const whole = [io.exitCode, io.stdout, io.stderr]
    expect(io.exitCode, io.stderrText).toBe(0)
    const cuts: number[][] = []
    for (let at = 0; at <= data.length; at++) cuts.push([at])
    cuts.push(Array.from({ length: data.length - 1 }, (_, i) => i + 1))
    for (const cut of cuts) {
      const pieces = await ws.shell(line, { stdin: splitSource(data, ...cut) })
      expect([pieces.exitCode, pieces.stdout, pieces.stderr], `cut at ${cut.join(',')}`).toEqual(
        whole,
      )
    }
  } finally {
    await ws.close()
  }
})
