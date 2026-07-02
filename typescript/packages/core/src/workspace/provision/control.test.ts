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
import { Precision, ProvisionResult } from '../../provision/types.ts'
import type { Session } from '../session/session.ts'
import { handleForProvision, handleIfProvision, handleWhileProvision } from './control.ts'

const COSTS: Record<string, () => ProvisionResult> = {
  cond: () =>
    new ProvisionResult({
      networkReadLow: 24,
      networkReadHigh: 24,
      readOps: 1,
      precision: Precision.EXACT,
    }),
  then: () =>
    new ProvisionResult({
      networkReadLow: 6,
      networkReadHigh: 6,
      readOps: 1,
      precision: Precision.EXACT,
    }),
  else: () =>
    new ProvisionResult({
      networkReadLow: 12,
      networkReadHigh: 12,
      readOps: 1,
      precision: Precision.EXACT,
    }),
  free: () => new ProvisionResult({ precision: Precision.EXACT }),
}

const node = (n: unknown): Promise<ProvisionResult> => {
  const make = COSTS[n as string]
  if (make === undefined) throw new Error(`unknown node ${String(n)}`)
  return Promise.resolve(make())
}

const SESSION = null as unknown as Session

describe('handleIfProvision', () => {
  it('sums the condition with each branch', async () => {
    const result = await handleIfProvision(node, [['cond', ['then']]], ['else'], SESSION)
    // then-path: 24 + 6 = 30; else-path: 24 + 12 = 36
    expect(result.networkReadLow).toBe(30)
    expect(result.networkReadHigh).toBe(36)
    expect(result.precision).toBe(Precision.RANGE)
  })

  it('without else still pays the conditions', async () => {
    const result = await handleIfProvision(node, [['cond', ['then']]], null, SESSION)
    // then-path: 24 + 6 = 30; fall-through still stats the condition: 24
    expect(result.networkReadLow).toBe(24)
    expect(result.networkReadHigh).toBe(30)
  })

  it('elif ladder accumulates conditions', async () => {
    const branches: [unknown, readonly unknown[]][] = [
      ['cond', ['free']],
      ['cond', ['then']],
    ]
    const result = await handleIfProvision(node, branches, null, SESSION)
    // branch1: 24; branch2: 24 + 24 + 6 = 54; fall-through: 48
    expect(result.networkReadLow).toBe(24)
    expect(result.networkReadHigh).toBe(54)
  })
})

describe('loops', () => {
  it('for scales and while is unknown', async () => {
    const scaled = await handleForProvision(node, ['then'], 3, SESSION)
    expect(scaled.networkReadLow).toBe(18)
    expect(scaled.precision).toBe(Precision.EXACT)
    const unknown = await handleWhileProvision(node, ['then'], SESSION)
    expect(unknown.precision).toBe(Precision.UNKNOWN)
  })
})
