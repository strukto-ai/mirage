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
  NetworkRule,
  networkBound,
  networkLayer,
  networkLets,
  runWithNetwork,
  sameNetwork,
  type NetworkSetting,
} from './network.ts'

describe('sameNetwork', () => {
  it.each<[NetworkSetting, NetworkSetting, boolean]>([
    [true, true, true],
    [false, { allow: [] }, true],
    [{ allow: ['a.com', 'b.com'] }, { allow: ['b.com', 'a.com', 'a.com'] }, true],
    [true, { allow: [] }, false],
    [{ allow: ['a.com'] }, { allow: ['b.com'] }, false],
    [{ allow: ['10.0.0.5'] }, { allow: ['10.0.0.5.'] }, false],
  ])('%o and %o: %s', (a, b, same) => {
    expect(sameNetwork(a, b)).toBe(same)
  })
})

describe('networkLayer', () => {
  it.each<[NetworkSetting, Record<string, unknown> | null]>([
    [true, null],
    [false, { allow: [] }],
    [{ allow: ['a.com'] }, { allow: ['a.com'] }],
  ])('adds the layer of %o', (setting, layer) => {
    expect(networkLayer(setting)).toEqual(layer)
  })

  it.each(['off', { deny: ['a.com'] }, { allow: 'a.com' }])('refuses %o', (setting) => {
    expect(() => networkLayer(setting)).toThrow(/network is true, false or/)
  })
})

describe('NetworkRule', () => {
  it('refuses a bad entry', () => {
    expect(() => new NetworkRule([{ allow: ['10.0.0.0/33'] }])).toThrow(
      /is not an address, a range/,
    )
  })

  it('holds only the call it is bound to', async () => {
    const rule = new NetworkRule([{ allow: ['*.github.com'] }])
    const asked = await runWithNetwork(rule, () => {
      expect(networkBound()).toBe(rule)
      return Promise.resolve([
        networkLets('api.github.com', '140.82.112.6'),
        networkLets('', '127.0.0.1'),
      ])
    })
    expect(asked).toEqual([true, false])
    expect(networkBound()).toBeNull()
    expect(networkLets('', '127.0.0.1')).toBe(true)
  })
})
