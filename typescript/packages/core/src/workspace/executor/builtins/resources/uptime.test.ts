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
import {
  decoded,
  resources,
  tableOf,
} from '../../../../../tests/workspace/fixtures/machine_resources.ts'
import { handleUptime, pretty, since, upText } from './uptime.ts'

describe('uptime', () => {
  it.each([
    [0, '0 min'],
    [59, '0 min'],
    [60, '1 min'],
    [3599, '59 min'],
    [3600, ' 1:00'],
    [3660, ' 1:01'],
    [86399, '23:59'],
    [86400, '1 day, 0 min'],
    [86460, '1 day, 1 min'],
    [90000, '1 day,  1:00'],
    [172800, '2 days, 0 min'],
    [694861, '8 days,  1:01'],
  ])('says %d seconds', (seconds, said) => {
    expect(upText(seconds)).toBe(said)
  })

  it.each([
    [0.5, 'up 0 minutes'],
    [60.5, 'up 1 minute'],
    [120.5, 'up 2 minutes'],
    [3600.5, 'up 1 hour, 0 minutes'],
    [3660.5, 'up 1 hour, 1 minute'],
    [86400.5, 'up 1 day, 0 minutes'],
    [90060.5, 'up 1 day, 1 hour, 1 minute'],
    [604800.5, 'up 1 week, 0 minutes'],
    [694861.5, 'up 1 week, 1 day, 1 hour, 1 minute'],
    [31536000.5, 'up 1 year, 0 minutes'],
    [31622460.5, 'up 1 year, 1 day, 1 minute'],
    [63072000.5, 'up 2 years, 0 minutes'],
    [315360000.5, 'up 1 decade, 0 minutes'],
  ])('says %d in words', (seconds, said) => {
    expect(pretty(seconds)).toBe(said)
  })

  it('reads the machine own clock for the boot time', () => {
    const row = resources('docker:a', { epoch: 1762745754, upSeconds: 59, offset: '-0800' })
    expect(since(row)).toBe('2025-11-09 19:34:55')
  })

  it('prints the line', async () => {
    const [out, io] = await handleUptime(tableOf([resources()]), ['uptime'])
    expect(decoded(out)).toBe(' 03:35:54 up 0 min,  0 users,  load average: 0.00, 0.10, 0.20\n')
    expect(io.exitCode).toBe(0)
  })

  it('says one user in the singular', async () => {
    const [out] = await handleUptime(tableOf([resources('docker:a', { users: 1 })]), ['uptime'])
    expect(decoded(out)).toContain('  1 user,  ')
  })

  it('ends each line with the machine for several', async () => {
    const table = tableOf([resources('docker:a'), resources('e2b:b')])
    const [out] = await handleUptime(table, ['uptime', '-p'])
    expect(decoded(out)).toBe('up 0 minutes  docker:a\nup 0 minutes  e2b:b\n')
  })

  it('lets -s outrank -p', async () => {
    const [out] = await handleUptime(tableOf([resources()]), ['uptime', '-p', '-s'])
    expect(decoded(out).startsWith('2025-')).toBe(true)
  })
})
