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
import { handleLscpu } from './lscpu.ts'

const ARM =
  'Architecture:                            aarch64\n' +
  'Byte Order:                              Little Endian\n' +
  'CPU(s):                                  1\n' +
  'Model name:                              -\n' +
  'Cluster(s):                              1\n' +
  'Flags:                                   fp asimd\n' +
  'Vulnerability L1tf:                      Not affected\n'
const INTEL =
  'Architecture:                            x86_64\n' +
  'Byte Order:                              Little Endian\n' +
  'CPU(s):                                  2\n' +
  'Model name:                              Intel Xeon\n' +
  'Socket(s):                               1\n'

function two(): JobTable {
  return tableOf([resources('docker:a', { cpuInfo: ARM }), resources('e2b:b', { cpuInfo: INTEL })])
}

describe('lscpu', () => {
  it('has a column a machine with dashes for the workspace', async () => {
    const [out, io] = await handleLscpu(two(), ['lscpu'])
    expect(decoded(out).split('\n').slice(0, -1)).toEqual([
      '               mirage         docker:a       e2b:b',
      'Architecture:  -              aarch64        x86_64',
      'Byte Order:    Little Endian  Little Endian  Little Endian',
      'CPU(s):        1              1              2',
      'Model name:    -              -              Intel Xeon',
      'Socket(s):     -              -              1',
      'Cluster(s):    -              1              -',
    ])
    expect(io.exitCode).toBe(0)
  })

  it('prints it as the machine did with --machine', async () => {
    expect(decoded((await handleLscpu(two(), ['lscpu', '--machine', 'docker:a']))[0])).toBe(ARM)
  })

  it('picks the workspace with --machine', async () => {
    const [out] = await handleLscpu(tableOf([resources()]), ['lscpu', '--machine=mirage'])
    expect(decoded(out)).toBe(
      `Byte Order:${' '.repeat(30)}Little Endian\nCPU(s):${' '.repeat(34)}1\n`,
    )
  })

  it('makes a machine without it a column of dashes', async () => {
    const table = tableOf([resources('docker:a'), resources('e2b:b', { cpuInfo: INTEL })])
    const [out] = await handleLscpu(table, ['lscpu'])
    expect(decoded(out).split('\n')[1]).toBe('Architecture:  -              -         x86_64')
  })

  it('says not found for one machine without it', async () => {
    const table = tableOf([resources('docker:a'), resources('e2b:b')])
    const [, io] = await handleLscpu(table, ['lscpu', '--machine', 'docker:a'])
    expect(io.exitCode).toBe(127)
    expect(decoded(io.stderr).endsWith('lscpu: command not found\n')).toBe(true)
  })

  it('refuses an unknown machine', async () => {
    const [, io] = await handleLscpu(tableOf([resources()]), ['lscpu', '--machine', 'nosuch'])
    expect([decoded(io.stderr), io.exitCode]).toEqual(['lscpu: nosuch: no such machine\n', 1])
  })
})
