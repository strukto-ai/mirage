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
import { darwinResourcesLine, RESOURCE_MARK as M, resourcesLine } from './constants.ts'
import { parseDarwinResources, parseResources } from './resources.ts'

const LINUX = `${M} cpus 5 8
${M} clock 1762745722 03:35:22 +0000
${M} load 0.16 0.03 0.01 2/103 102
${M} up 3661.50
${M} users 2
${M} mem MemTotal: 8000000
${M} mem MemFree: 1234567
${M} mem MemAvailable: 6543210
${M} mem Buffers: 54321
${M} mem Cached: 2345678
${M} mem SwapTotal: 2097148
${M} mem SwapFree: 2000000
${M} mem Shmem: 12345
${M} mem SReclaimable: 111111
${M} mem CommitLimit: 6097148
${M} mem Committed_AS: 3000000
provider banner that is not a row
`
const DARWIN = `${M} cpus 14 14
${M} clock 1762745722 19:35:22 -0800
${M} load { 3.54 3.94 5.27 }
${M} boot { sec = 1762700000, usec = 1 } Sun Nov  9 06:53:20 2025
${M} users 2
${M} memsize 51539607552
${M} swap total = 7168.00M  used = 6045.00M  free = 1123.00M  (encrypted)
${M} vm Mach Virtual Memory Statistics: (page size of 16384 bytes)
${M} vm Pages free:                               716727.
${M} vm Pages inactive:                           844469.
${M} vm Pages speculative:                         43344.
${M} top Processes: 875 total, 5 running, 870 sleeping, 6000 threads
${M} top CPU usage: 15.10% user, 8.30% sys, 76.60% idle
`

describe('resources', () => {
  it('samples only when asked', () => {
    expect(resourcesLine(false)).not.toContain('/proc/stat')
    expect(resourcesLine(true)).toContain('/proc/stat')
    expect(darwinResourcesLine(false)).not.toContain('top -l')
    expect(darwinResourcesLine(true)).toContain('top -l')
  })

  it('reads a Linux machine', () => {
    const found = parseResources(LINUX, 'docker:a')
    expect([found.machine, found.cpus, found.allCpus]).toEqual(['docker:a', 5, 8])
    expect([found.clock, found.offset]).toEqual(['03:35:22', '+0000'])
    expect(found.load).toEqual([0.16, 0.03, 0.01])
    expect([found.upSeconds, found.users]).toEqual([3661.5, 2])
    expect(found.memTotal).toBe(8000000 * 1024)
    expect(found.memAvailable).toBe(6543210 * 1024)
    expect(found.cached).toBe((2345678 + 111111) * 1024)
    expect(found.lowTotal).toBe(found.memTotal)
    expect(found.highTotal).toBe(0)
    expect(found.cpu).toBeNull()
    expect(found.tasks).toBeNull()
  })

  it('reads the time between two samples', () => {
    const sampled = `${LINUX}${M} before cpu  100 0 100 800 0 0 0 0 0 0\n${M} after cpu  150 0 100 850 0 0 0 0 0 0\n${M} states SSRZT\n`
    const found = parseResources(sampled, 'docker:a')
    expect([found.cpu?.user, found.cpu?.idle]).toEqual([50, 50])
    expect(found.tasks).toEqual({ total: 5, running: 1, sleeping: 2, stopped: 1, zombie: 1 })
  })

  it('refuses a machine that said nothing', () => {
    expect(() => parseResources('nothing\n', 'docker:a')).toThrow()
  })

  it('reads a Mac', () => {
    const found = parseDarwinResources(DARWIN, 'host:mac')
    expect([found.cpus, found.allCpus]).toEqual([14, 14])
    expect(found.load).toEqual([3.54, 3.94, 5.27])
    expect(found.upSeconds).toBe(45722)
    expect(found.memTotal).toBe(51539607552)
    expect(found.memFree).toBe(716727 * 16384)
    expect(found.cached).toBe((844469 + 43344) * 16384)
    expect(found.memAvailable).toBe(found.memFree + (found.cached ?? 0))
    expect(found.shared).toBeNull()
    expect(found.buffers).toBeNull()
    expect(found.swapTotal).toBe(7168 * 1024 ** 2)
    expect(found.swapFree).toBe(1123 * 1024 ** 2)
    expect(found.tasks?.total).toBe(875)
    expect([found.cpu?.user, found.cpu?.system, found.cpu?.wait]).toEqual([15.1, 8.3, null])
  })
})
