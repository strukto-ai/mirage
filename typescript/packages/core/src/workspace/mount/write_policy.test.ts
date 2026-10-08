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
import { MountBackend, MountMode, WritePolicy } from '../../types.ts'
import type { BaseVFS } from '../../vfs/base.ts'
import {
  checkWriteCapability,
  coerceWritePolicy,
  conditionalOverlap,
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
  backend: string
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

  it.each([true, 1])('refuses a non-string %s', (value) => {
    expect(() => coerceWritePolicy(value)).toThrow('unknown write policy')
  })
})

describe('the condition table', () => {
  it('is the shared fixture, both ways', () => {
    const rows = Object.entries(CONDITIONS.vfs).filter(([, ops]) => ops.length > 0)
    expect(rows.length).toBeGreaterThan(0)
    expect(sortedRows(WRITE_CONDITIONS)).toEqual(sortedRows(Object.fromEntries(rows)))
  })

  it('gives an s3 mount on a custom endpoint the minio row', () => {
    // Any S3-compatible server can sit behind type: s3, MinIO included,
    // and MinIO ignores copy and delete conditions (measured 2026-10-06).
    expect([...writeConditions(stub('s3', { bucket: 'b' }))].sort()).toEqual(
      [...(CONDITIONS.vfs.s3 ?? [])].sort(),
    )
    expect(
      [
        ...writeConditions(
          stub('s3', { bucket: 'b', endpoint: 'https://s3.us-west-2.amazonaws.com' }),
        ),
      ].sort(),
    ).toEqual([...(CONDITIONS.vfs.s3 ?? [])].sort())
    expect(
      [...writeConditions(stub('s3', { bucket: 'b', endpoint: 'http://127.0.0.1:9000' }))].sort(),
    ).toEqual([...CONDITIONS['s3+endpoint']].sort())
  })

  it('counts an AWS China endpoint as AWS', () => {
    expect(
      [
        ...writeConditions(
          stub('s3', { bucket: 'b', endpoint: 'https://s3.cn-north-1.amazonaws.com.cn' }),
        ),
      ].sort(),
    ).toEqual([...(CONDITIONS.vfs.s3 ?? [])].sort())
  })

  it('gives a presigned-URL config no condition', () => {
    // The browser's fetch client sends only the body and the copy source,
    // so a condition would be dropped on the way out.
    const presigned = stub('s3', { bucket: 'b', presignedUrlProvider: () => 'u' })
    expect(writeConditions(presigned).length).toBe(0)
    expect(() => {
      checkWriteCapability(
        '/x/',
        presigned,
        WritePolicy.CONDITIONAL,
        MountMode.WRITE,
        MountBackend.WORKSPACE,
        true,
      )
    }).toThrow(
      "mount '/x/': write: conditional cannot be sent through a presigned-URL client, which carries no condition",
    )
  })
})

describe('checkWriteCapability', () => {
  it('reads a non-empty corpus', () => {
    expect(VERDICTS.length).toBeGreaterThan(0)
  })

  it.each(VERDICTS.map((c) => [c.name, c] as const))('matches the shared fixture: %s', (_n, c) => {
    const vfs = { name: c.vfs, cachesReads: c.caches } as unknown as BaseVFS
    const run = () => {
      checkWriteCapability(
        '/x/',
        vfs,
        coerceWritePolicy(c.policy),
        c.mode as MountMode,
        c.backend as MountBackend,
        c.caches,
      )
    }
    if (c.expect === null) {
      run()
      return
    }
    // Exact, as python compares: a message with anything more is a drift.
    expect(run).toThrow(new RegExp(`^${c.expect.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
  })
})

describe('conditionalOverlap', () => {
  const mounts = [
    { prefix: '/s3/', write: WritePolicy.CONDITIONAL },
    { prefix: '/d/', write: WritePolicy.UNCONDITIONAL },
  ]

  it.each([
    ['/s3', '/s3/'],
    ['/', '/s3/'],
    ['/s3/sub', '/s3/'],
    ['/d', null],
    ['/other', null],
  ] as const)('an exposure of %s reaches %s', (prefix, expected) => {
    expect(conditionalOverlap(mounts, prefix)).toBe(expected)
  })
})
