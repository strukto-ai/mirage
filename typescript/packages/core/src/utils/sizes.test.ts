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
import { FileStat, FileType } from '../types.ts'
import { reportedSize, uploadReceipt } from './sizes.ts'

const FIXTURE = new URL('../../../../../integ/fixtures/sizes/reported_size.json', import.meta.url)

interface SizeCase {
  name: string
  value?: unknown
  repeat?: string
  times?: number
  expected: number | null
}

const CASES = (JSON.parse(readFileSync(FIXTURE, 'utf-8')) as { cases: SizeCase[] }).cases

function valueOf(c: SizeCase): unknown {
  if (c.repeat !== undefined) return c.repeat.repeat(c.times ?? 0)
  return c.value
}

describe('reportedSize', () => {
  it('reads a non-empty shared fixture', () => {
    // integ/fixtures/sizes/reported_size.json is the contract: the python
    // suite (tests/utils/test_sizes.py) reads the same rows.
    expect(CASES.length).toBeGreaterThan(0)
  })

  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const got = reportedSize(valueOf(c))
    if (c.expected === null) {
      expect(got).toBeNull()
    } else {
      // Object.is, so JSON's -0 must come back as 0.
      expect(Object.is(got, c.expected)).toBe(true)
    }
  })
})

interface Reply {
  size?: unknown
  token?: string
}

function stat(item: Reply): FileStat {
  return new FileStat({ name: 'f.txt', type: FileType.FILE, fingerprint: item.token ?? null })
}

describe('uploadReceipt', () => {
  // [name, reply item, expected [bytes, token]] for 5 sent bytes.
  it.each<[string, unknown, [number, string | null]]>([
    ['agrees', { size: 5, token: 't5' }, [5, 't5']],
    ['stored size differs', { size: 9, token: 't5' }, [9, 't5']],
    ['empty token', { size: 5, token: '' }, [5, null]],
    ['token without size', { token: 't5' }, [5, null]],
    ['bad size', { size: 'x', token: 't5' }, [5, null]],
    ['no reply', null, [5, null]],
    ['string reply', 'not json', [5, null]],
    ['list reply', ['not', 'a', 'dict'], [5, null]],
  ])('%s', (_name, item, expected) => {
    // A reply is untrusted JSON, so the non-object rows stand in as one.
    expect(uploadReceipt(item as Reply | null, stat, 5, '/m/f.txt')).toEqual(expected)
  })

  it.each([5, 9])('keeps the size %i and drops the token when the parser throws', (size) => {
    // The size still reaches the cache's size check, so a write stored at
    // another size is dropped rather than kept untokened.
    const calls: unknown[] = []
    const item = { size, token: 't' }
    const parse = (got: unknown): FileStat => {
      calls.push(got)
      throw new Error('bad reply')
    }
    expect(uploadReceipt(item, parse, 5, '/m/f.txt')).toEqual([size, null])
    expect(calls).toEqual([item])
  })
})
