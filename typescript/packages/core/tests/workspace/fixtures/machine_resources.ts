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

import { JobTable } from '../../../src/execution/job/index.ts'
import type { MachineResources } from '../../../src/execution/types.ts'

export function resources(
  machine = 'docker:a',
  fields: Partial<MachineResources> = {},
): MachineResources {
  return {
    machine,
    cpus: 4,
    allCpus: 8,
    epoch: 1762745722,
    clock: '03:35:54',
    offset: '+0000',
    upSeconds: 0.5,
    load: [0, 0.1, 0.2],
    users: 0,
    memTotal: 8000000 * 1024,
    memFree: 1234567 * 1024,
    memAvailable: 6543210 * 1024,
    swapTotal: 2097148 * 1024,
    swapFree: 2000000 * 1024,
    shared: 12345 * 1024,
    buffers: 54321 * 1024,
    cached: 2456789 * 1024,
    commitLimit: 6097148 * 1024,
    committed: 3000000 * 1024,
    lowTotal: 8000000 * 1024,
    lowFree: 1234567 * 1024,
    highTotal: 0,
    highFree: 0,
    tasks: null,
    cpu: null,
    hostname: '',
    cpuInfo: '',
    ...fields,
  }
}

export function tableOf(rows: readonly MachineResources[], ids?: readonly string[]): JobTable {
  const table = new JobTable()
  const byId = new Map(rows.map((row) => [row.machine, row]))
  table.processes.machineNames = () => [...(ids ?? byId.keys())]
  table.processes.machineResources = (machine) => {
    const row = byId.get(machine)
    return row === undefined ? Promise.reject(new Error('down')) : Promise.resolve(row)
  }
  return table
}

export function decoded(data: unknown): string {
  return data instanceof Uint8Array ? new TextDecoder().decode(data) : ''
}
