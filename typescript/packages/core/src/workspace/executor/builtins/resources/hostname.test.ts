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
import { handleHostname } from './hostname.ts'

function two(): JobTable {
  return tableOf([
    resources('docker:a', { hostname: 'box-one' }),
    resources('e2b:b', { hostname: 'e2b.local' }),
  ])
}

describe('hostname', () => {
  it('lists the workspace then each machine', async () => {
    const [out, io] = await handleHostname(two(), ['hostname'])
    expect([decoded(out), io.exitCode]).toEqual(['mirage\nbox-one\ne2b.local\n', 0])
  })

  it('picks one with --machine', async () => {
    expect(decoded((await handleHostname(two(), ['hostname', '--machine=b']))[0])).toBe(
      'e2b.local\n',
    )
  })

  it('picks the workspace with --machine', async () => {
    const [out] = await handleHostname(two(), ['hostname', '--machine', 'mirage'])
    expect(decoded(out)).toBe('mirage\n')
  })

  it('refuses an unknown machine', async () => {
    const [, io] = await handleHostname(two(), ['hostname', '--machine', 'nosuch'])
    expect([decoded(io.stderr), io.exitCode]).toEqual(['hostname: nosuch: no such machine\n', 1])
  })

  it('leaves a silent machine out and says so', async () => {
    const table = tableOf([resources('docker:a', { hostname: 'box-one' })], ['docker:a', 'e2b:b'])
    const [out, io] = await handleHostname(table, ['hostname'])
    expect([decoded(out), decoded(io.stderr), io.exitCode]).toEqual([
      'mirage\nbox-one\n',
      'hostname: e2b:b: machine did not answer\n',
      1,
    ])
  })
})
