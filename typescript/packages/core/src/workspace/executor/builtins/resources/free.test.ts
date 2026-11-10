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
import type { JobTable } from '../../../../execution/job/index.ts'
import {
  decoded,
  resources,
  tableOf,
} from '../../../../../tests/workspace/fixtures/machine_resources.ts'
import { MemoryBudget, runWithMemory } from '../../../../io/memory.ts'
import { handleFree, humanSize } from './free.ts'

const HEADER = '               total        used        free      shared  buff/cache   available'
const MEM = 'Mem:         8000000     1456790     1234567       12345     2511110     6543210'
const SWAP = 'Swap:        2097148       97148     2000000'

async function freeOf(words: string[], table?: JobTable): Promise<[string, string, number]> {
  const picked = table === undefined ? ['--machine', 'docker:a'] : []
  const [out, io] = await handleFree(table ?? tableOf([resources()]), ['free', ...picked, ...words])
  return [decoded(out), decoded(io.stderr), io.exitCode]
}

describe('free', () => {
  it.each([
    [0, '0B'],
    [1, '1.0Ki'],
    [9, '9.0Ki'],
    [10, '10Ki'],
    [512, '512Ki'],
    [999, '999Ki'],
    [1000, '1.0Mi'],
    [1024, '1.0Mi'],
    [1536, '1.5Mi'],
    [10188, '9.9Mi'],
    [10189, '9Mi'],
    [10239, '9Mi'],
    [10240, '10Mi'],
    [102400, '100Mi'],
    [1100000, '1.0Gi'],
    [10433331, '9.9Gi'],
    [10433332, '9Gi'],
    [10485760, '10Gi'],
    [1099511627776, '1.0Pi'],
  ])('rounds %d KiB as procps does', (kib, shown) => {
    expect(humanSize(kib * 1024, false)).toBe(shown)
  })

  it('prints kibibytes by default', async () => {
    expect(await freeOf([])).toEqual([`${HEADER}\n${MEM}\n${SWAP}\n`, '', 0])
  })

  it.each([
    [['-b'], '8192000000'],
    [['--kilo'], '8192000'],
    [['--mega'], '8192'],
    [['--giga'], '8'],
    [['-m'], '7812'],
    [['-g'], '7'],
    [['--si'], '8192000'],
    [['--si', '-m'], '8192'],
  ])('scales every figure with %j', async (words, total) => {
    const [out] = await freeOf(words)
    expect(out.split('\n')[1]?.trim().split(/\s+/)[1]).toBe(total)
  })

  it('drops the i with --si', async () => {
    const [out] = await freeOf(['-h', '--si'])
    expect(out.split('\n')[1]?.trim().split(/\s+/).slice(1, 3)).toEqual(['8.2G', '1.5G'])
  })

  it('adds the total, committed and low rows', async () => {
    const rows = (await freeOf(['-t', '-v', '-l']))[0].split('\n')
    expect(rows[2]).toBe('Low:         8000000     6765433     1234567')
    expect(rows[3]).toBe('High:              0           0           0')
    expect(rows[5]).toBe('Total:      10097148     1553938     3234567')
    expect(rows[6]).toBe('Comm:        6097148     3000000     3097148')
  })

  it('splits buffers from cache with -w', async () => {
    const rows = (await freeOf(['-w']))[0].split('\n')
    expect(rows[0]?.trim().split(/\s+/).slice(4, 6)).toEqual(['buffers', 'cache'])
    expect(rows[1]?.trim().split(/\s+/).slice(5, 7)).toEqual(['54321', '2456789'])
  })

  it('prints one line with -L', async () => {
    expect((await freeOf(['-L']))[0]).toBe(
      'SwapUse       97148 CachUse     2511110  MemUse     1456790 MemFree     1234567 \n',
    )
  })

  it('keeps each figure where it was for several machines', async () => {
    const table = tableOf([resources('docker:a'), resources('e2b:b')])
    const rows = (await freeOf([], table))[0].split('\n')
    expect(rows[0]).toBe(`${HEADER}  MACHINE`)
    expect(rows[3]).toBe(`${MEM}  docker:a`)
    expect(rows[4]?.endsWith('  docker:a')).toBe(true)
    expect(rows[4]?.length).toBe(rows[3]?.length)
    expect(rows[5]).toBe(`${MEM}  e2b:b`)
  })

  it('shows the max_memory in the workspace row', async () => {
    const budget = new MemoryBudget(32 << 20, () => 2 << 20)
    const [out] = await runWithMemory(budget, () => freeOf(['-m'], tableOf([resources()])))
    const rows = out.split('\n')
    expect(rows[1]?.trim().split(/\s+/)).toEqual([
      'Mem:',
      '32',
      '2',
      '30',
      '-',
      '-',
      '30',
      'mirage',
    ])
    expect(rows[2]?.trim().split(/\s+/)).toEqual(['Swap:', '0', '0', '0', 'mirage'])
  })

  it('leaves the workspace row blank with no max_memory', async () => {
    const rows = (await freeOf(['-m'], tableOf([resources()])))[0].split('\n')
    expect(rows[1]?.trim().split(/\s+/)).toEqual(['Mem:', '-', '-', '-', '-', '-', '-', 'mirage'])
    expect(rows[2]?.trim().split(/\s+/)).toEqual(['Swap:', '-', '-', '-', 'mirage'])
  })

  it('answers alone in a workspace with no machine', async () => {
    const budget = new MemoryBudget(32 << 20, () => 0)
    const [out, , code] = await runWithMemory(budget, () => freeOf(['-m'], tableOf([], [])))
    expect(code).toBe(0)
    const rows = out.split('\n')
    expect(rows[0]).toBe(HEADER)
    expect(rows[1]?.trim().split(/\s+/)).toEqual(['Mem:', '32', '0', '32', '-', '-', '32'])
  })

  it('picks the workspace with --machine', async () => {
    const budget = new MemoryBudget(32 << 20, () => 0)
    const [out] = await runWithMemory(budget, () =>
      freeOf(['-m', '--machine', 'mirage'], tableOf([resources()])),
    )
    const rows = out.split('\n')
    expect(rows[0]).toBe(HEADER)
    expect(rows[1]?.trim().split(/\s+/)[1]).toBe('32')
  })

  it('prints a dash for a figure a machine lacks', async () => {
    const table = tableOf([resources('docker:a', { shared: null, buffers: null, cached: null })])
    expect(
      (await freeOf(['--machine', 'docker:a'], table))[0]
        .split('\n')[1]
        ?.trim()
        .split(/\s+/)
        .slice(4, 6),
    ).toEqual(['-', '-'])
  })

  it('narrows to one machine and drops the column', async () => {
    const table = tableOf([resources('docker:a'), resources('e2b:b')])
    expect((await freeOf(['--machine', 'b'], table))[0]).toBe(`${HEADER}\n${MEM}\n${SWAP}\n`)
  })

  it('refuses an unknown machine', async () => {
    expect(await freeOf(['--machine', 'nosuch'])).toEqual([
      '',
      'free: nosuch: no such machine\n',
      1,
    ])
  })

  it('says which machine did not answer', async () => {
    const table = tableOf([resources('docker:a')], ['docker:a', 'e2b:down'])
    const [out, err, code] = await freeOf([], table)
    expect(out).toContain('docker:a')
    expect(out).not.toContain('e2b:down')
    expect(err).toBe('free: e2b:down: machine did not answer\n')
    expect(code).toBe(1)
  })

  it.each([
    [['-m', '-g'], "free: Multiple unit options don't make sense.\n"],
    [['-s', 'abc'], "free: seconds argument failed: 'abc': Invalid argument\n"],
    [['-s', '0'], "free: seconds argument `0' is not positive number\n"],
    [['-c', 'abc'], "free: failed to parse count argument: 'abc'\n"],
    [['-c', '0'], "free: failed to parse count argument: '0': Numerical result out of range\n"],
  ])('refuses %j in procps words', async (words, said) => {
    expect((await freeOf(words)).slice(1)).toEqual([said, 1])
  })

  it('prints the usage page for an unknown option', async () => {
    const [, err, code] = await freeOf(['-x'])
    expect(err.startsWith("free: invalid option -- 'x'\n\n")).toBe(true)
    expect(code).toBe(1)
  })
})
