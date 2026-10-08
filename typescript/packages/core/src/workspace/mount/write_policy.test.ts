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

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MountMode, WritePolicy } from '../../types.ts'
import type { BaseVFS } from '../../vfs/base.ts'
import {
  checkWriteCapability,
  coerceWritePolicy,
  WRITE_CONDITIONS,
  writeConditions,
} from './write_policy.ts'

const FIXTURES = new URL('../../../../../../integ/fixtures/write/', import.meta.url)

interface ConditionsFixture {
  vfs: Record<string, string[]>
  's3+endpoint': string[]
}

interface VerdictCase {
  name: string
  vfs: string
  policy: string
  mode: string
  caches: boolean
  expect: string | null
}

const CONDITIONS = JSON.parse(
  readFileSync(new URL('conditions.json', FIXTURES), 'utf-8'),
) as ConditionsFixture
const VERDICTS = (
  JSON.parse(readFileSync(new URL('verdicts.json', FIXTURES), 'utf-8')) as {
    cases: VerdictCase[]
  }
).cases

function sortedRows(r: Record<string, readonly string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, [...v].sort()]))
}

function stub(name: string, config?: Record<string, unknown>): BaseVFS {
  return {
    name,
    cachesReads: true,
    ...(config !== undefined ? { config } : {}),
  } as unknown as BaseVFS
}

describe('coerceWritePolicy', () => {
  it.each([
    [undefined, WritePolicy.UNCONDITIONAL],
    [null, WritePolicy.UNCONDITIONAL],
    ['', WritePolicy.UNCONDITIONAL],
    ['conditional', WritePolicy.CONDITIONAL],
    ['CONDITIONAL', WritePolicy.CONDITIONAL],
    ['staged', WritePolicy.STAGED],
  ] as const)('coerces %s', (value, expected) => {
    expect(coerceWritePolicy(value)).toBe(expected)
  })

  it('names the choices for an unknown policy', () => {
    expect(() => coerceWritePolicy('banana')).toThrow(
      "unknown write policy 'banana'; expected one of: unconditional, conditional, staged",
    )
  })
})

describe('the condition table', () => {
  it('is the shared fixture, both ways', () => {
    const rows = Object.entries(CONDITIONS.vfs).filter(([, ops]) => ops.length > 0)
    expect(rows.length).toBeGreaterThan(0)
    expect(sortedRows(WRITE_CONDITIONS)).toEqual(sortedRows(Object.fromEntries(rows)))
  })

  it.each([
    ['none declared', undefined, 's3'],
    ['regional', 'https://s3.us-west-2.amazonaws.com', 's3'],
    ['china', 'https://s3.cn-north-1.amazonaws.com.cn', 's3'],
    ['custom', 'http://127.0.0.1:9000', 's3+endpoint'],
  ] as const)('judges an s3 mount on its declared endpoint: %s', (_name, endpoint, expected) => {
    const vfs = stub('s3', { bucket: 'b', ...(endpoint !== undefined ? { endpoint } : {}) })
    const want = expected === 's3' ? (CONDITIONS.vfs.s3 ?? []) : CONDITIONS['s3+endpoint']
    expect([...writeConditions(vfs)].sort()).toEqual([...want].sort())
  })

  it('gives a presigned-URL config no condition', () => {
    // The browser's fetch client would drop a condition on the way out.
    const presigned = stub('s3', { bucket: 'b', presignedUrlProvider: () => 'u' })
    expect(writeConditions(presigned).length).toBe(0)
    expect(() => {
      checkWriteCapability('/x/', presigned, WritePolicy.CONDITIONAL, MountMode.WRITE, true)
    }).toThrow(
      "mount '/x/': write: conditional cannot be sent through a presigned-URL client, which carries no condition",
    )
  })
})

describe('checkWriteCapability', () => {
  it.each(VERDICTS.map((c) => [c.name, c] as const))('matches the shared fixture: %s', (_n, c) => {
    const vfs = { name: c.vfs, cachesReads: c.caches } as unknown as BaseVFS
    const run = () => {
      checkWriteCapability('/x/', vfs, coerceWritePolicy(c.policy), c.mode as MountMode, c.caches)
    }
    if (c.expect === null) {
      run()
      return
    }
    // Exact, as python compares: a message with anything more is a drift.
    expect(run).toThrow(new RegExp(`^${c.expect.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
  })
})
