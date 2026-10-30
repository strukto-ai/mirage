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
import { refused, scan } from './scan.ts'

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
