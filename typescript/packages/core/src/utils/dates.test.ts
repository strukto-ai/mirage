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
import { epochToIso, isoToEpoch, utcDateFolder } from './dates.ts'

describe('epochToIso', () => {
  it('formats whole seconds as second-precision ISO-Z', () => {
    expect(epochToIso(1609459200)).toBe('2021-01-01T00:00:00Z')
  })
  it('truncates sub-second input (parity with the Python converter)', () => {
    expect(epochToIso(1609459200.987)).toBe('2021-01-01T00:00:00Z')
  })
})

describe('isoToEpoch', () => {
  it('inverts epochToIso for a Z stamp', () => {
    expect(isoToEpoch('2021-01-01T00:00:00Z')).toBe(1609459200)
    expect(isoToEpoch('2026-01-02T15:30:45Z')).toBe(1767367845)
  })
  it('reads an offset-less (naive) stamp as UTC, not local', () => {
    expect(isoToEpoch('2026-01-02T15:30:45')).toBe(1767367845)
  })
  it('honors an explicit offset and truncates sub-seconds', () => {
    expect(isoToEpoch('2021-01-01T01:00:00+01:00')).toBe(1609459200)
    expect(isoToEpoch('2026-07-22T06:57:48.064802Z')).toBe(1784703468)
  })
  it('floors a negative fractional epoch (parity with Python)', () => {
    expect(isoToEpoch('1969-12-31T23:59:59.500Z')).toBe(-1)
    expect(epochToIso(-0.5)).toBe('1969-12-31T23:59:59Z')
  })
})

describe('utcDateFolder', () => {
  it('returns YYYY-MM-DD for a timestamp', () => {
    expect(utcDateFolder(1609459200000)).toBe('2021-01-01')
  })
})
