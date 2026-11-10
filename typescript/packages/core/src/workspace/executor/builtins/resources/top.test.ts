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
import type { Process } from '../../../../execution/process/types.ts'
import { LineId, MachineId, type MachineResources, ProcessId } from '../../../../execution/types.ts'
import { PathSpec } from '../../../../types.ts'
import {
  decoded,
  resources,
  tableOf,
} from '../../../../../tests/workspace/fixtures/machine_resources.ts'
import { handleTop, since } from './top.ts'

const SAMPLED: Partial<MachineResources> = {
  tasks: { total: 60, running: 1, sleeping: 59, stopped: 0, zombie: 0 },
  cpu: {
    user: 0,
    system: 0,
    idle: 100,
    nice: 0,
    wait: 0,
    hardware: 0,
    software: 0,
    stolen: 0,
  },
  load: [0.16, 0.03, 0.01],
  memTotal: Math.trunc(981.8 * 1024 ** 2),
  memFree: Math.trunc(837.5 * 1024 ** 2),
  memAvailable: Math.trunc(941.3 * 1024 ** 2),
  buffers: 0,
  cached: Math.trunc(119.7 * 1024 ** 2),
  swapTotal: 0,
  swapFree: 0,
}

function busy(pid: number, cpuSeconds: number): Process {
  return {
    id: new ProcessId('w', pid),
    sessionId: 's',
    line: new LineId('line_1'),
    parent: null,
    group: pid,
    command: 'sleep 30',
    cwd: PathSpec.fromStrPath('/'),
    machine: new MachineId('host', 'box'),
    startedAt: 1,
    runtime: null,
    machinePid: null,
    state: 'running',
    endedAt: null,
    exit: null,
    signal: null,
    error: null,
    ancestors: [],
    usage: { cpuSeconds, cpuPercent: 1, memoryPercent: 0, rss: 0, vsz: 0 },
  }
}

async function topOf(
  words: string[],
  table: JobTable = tableOf([resources('docker:a', SAMPLED)]),
): Promise<[string[], string, number]> {
  const [out, io] = await handleTop(table, ['top', ...words])
  return [decoded(out).split('\n'), decoded(io.stderr), io.exitCode]
}

describe('top', () => {
  it('prints the summary in procps layout', async () => {
    const [lines, , code] = await topOf(['-b', '-n', '1'])
    expect(lines.slice(0, 7)).toEqual([
      'top - 03:35:54 up 0 min,  0 users,  load average: 0.16, 0.03, 0.01',
      'Tasks:  60 total,   1 running,  59 sleeping,   0 stopped,   0 zombie',
      '%Cpu(s):  0.0 us,  0.0 sy,  0.0 ni,100.0 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st ',
      'MiB Mem :    981.8 total,    837.5 free,     40.5 used,    119.7 buff/cache     ',
      'MiB Swap:      0.0 total,      0.0 free,      0.0 used.    941.3 avail Mem ',
      '',
      '  PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND',
    ])
    expect(code).toBe(0)
  })

  it('cuts every line to -w', async () => {
    const [lines] = await topOf(['-bn1', '-w', '10'])
    expect(lines.slice(0, 2)).toEqual(['top - 03:3', 'Tasks:  60'])
  })

  it('scales memory with -E', async () => {
    expect((await topOf(['-b', '-n1', '-E', 'g']))[0][3]).toMatch(/^GiB Mem : {6}1\.0 total,/)
  })

  it('ends each summary line in the machine for several', async () => {
    const table = tableOf([resources('docker:a', SAMPLED), resources('e2b:b', SAMPLED)])
    const [lines] = await topOf(['-bn1'], table)
    expect(lines[0]?.endsWith('0.01  docker:a')).toBe(true)
    expect(lines[3]?.endsWith('buff/cache  docker:a')).toBe(true)
    expect(lines[5]?.endsWith('0.01  e2b:b')).toBe(true)
    expect(lines[11]?.endsWith('MACHINE COMMAND')).toBe(true)
  })

  it.each([
    [[], 'top: failed tty get\n'],
    [['-b', '-n', 'abc'], "top: bad iterations argument 'abc'\n"],
    [['-b', '-n', '0'], "top: bad iterations argument '0'\n"],
    [['-b', '-d', 'abc', '-n1'], "top: bad delay interval 'abc'\n"],
    [['-b', '-d', '-1', '-n1'], 'top: -d requires positive argument\n'],
    [['-bn1', '-o', 'nosuch'], "top: unrecognized field name 'nosuch'\n"],
    [['-bn1', '-E', 'z'], "top: bad memory scaling arg 'z'\n"],
    [['-bn1', '-p', 'abc'], "top: bad pid 'abc'\n"],
    [['-bn1', '-w', 'abc'], "top: bad width arg 'abc'\n"],
    [['-bn'], "top: option requires an argument -- 'n'\n"],
    [['-x'], "top: invalid option -- 'x'\n"],
    [['-bn1', 'extra'], "top: unknown option 'extra'\n"],
  ])('refuses %j in procps words', async (words: string[], said: string) => {
    expect((await topOf(words)).slice(1)).toEqual([said, 1])
  })

  it('shows the cpu since the frame before in a later frame', () => {
    const samples = new Map<number, [number, number]>()
    const first = since([busy(7, 10)], samples, 100)
    expect(first.map((row) => row.usage?.cpuPercent)).toEqual([1])
    const later = since([busy(7, 11.5), busy(8, 3)], samples, 102)
    expect(later.map((row) => row.usage?.cpuPercent)).toEqual([75, 1])
    expect([...samples]).toEqual([
      [7, [11.5, 102]],
      [8, [3, 102]],
    ])
  })
})
