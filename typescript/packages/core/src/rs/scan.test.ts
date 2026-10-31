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

import { expect, it } from 'vitest'
import { StreamRefusal } from './errors.ts'
import { UsageError } from '../commands/errors.ts'
import { PARSE_KEPT_CHARS } from '../commands/spec/constants.ts'
import { refused, scan, scanned, SCANS } from './scan.ts'

it('reads each value typed', () => {
  const values = scan('cmp', [
    ['ignore_initial', '1K:2'],
    ['bytes', '0x10'],
  ])
  expect(values).toEqual({ limit: 16, skip: [1024, 2] })
})

it('keeps a refusal its bytes and status', () => {
  let caught: unknown
  try {
    scan('cmp', [['bytes', '1é']])
  } catch (err) {
    caught = err
  }
  if (!(caught instanceof StreamRefusal)) throw new Error('scan took the value')
  expect(caught.status).toBe(2)
  const result = refused(caught)
  expect(result.exitCode).toBe(2)
  expect(result.stderr).toEqual(
    new TextEncoder().encode(
      "cmp: invalid --bytes value '1é'\ncmp: Try 'cmp --help' for more information.\n",
    ),
  )
})

it('throws a refusal as the usage error it is', () => {
  let caught: unknown
  try {
    scanned('grep', [['after_context', 'é']])
  } catch (err) {
    caught = err
  }
  if (!(caught instanceof UsageError)) throw new Error('scanned took the value')
  expect([caught.message, caught.exitCode]).toEqual(['grep: é: invalid context length argument', 2])
  expect(scanned('grep', [['max_count', '-1']]).max_count).toBeNull()
})

it("keeps a reader's change to a kept scan its own", () => {
  const first = scan('cmp', [['ignore_initial', '3K:4']])
  first.skip = []
  expect(scan('cmp', [['ignore_initial', '3K:4']])).toEqual({ limit: null, skip: [3072, 4] })
})

it('refuses every reader of a kept refusal', () => {
  for (let round = 0; round < 2; round++) {
    let caught: unknown
    try {
      scan('cmp', [['bytes', '2é']])
    } catch (err) {
      caught = err
    }
    if (!(caught instanceof StreamRefusal)) throw new Error('scan took the value')
    const result = refused(caught)
    expect([result.exitCode, result.stderr]).toEqual([
      2,
      new TextEncoder().encode(
        "cmp: invalid --bytes value '2é'\ncmp: Try 'cmp --help' for more information.\n",
      ),
    ])
  }
})

it('keeps no long run of switches', () => {
  SCANS.clear()
  const switches = Array.from({ length: PARSE_KEPT_CHARS }, () => ['recursive', ''] as const)
  scan('grep', switches)
  scan('grep', switches.slice(0, 1))
  expect([...(SCANS.get('grep')?.keys() ?? [])]).toEqual([JSON.stringify([['recursive', '']])])
})
