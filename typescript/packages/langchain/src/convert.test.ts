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
import { ioToExecuteResponse, ioToFileInfos, ioToGrepMatches } from './convert.ts'

interface FakeIO {
  stdoutText: string
  stderrText: string
  exitCode: number | null
}

function fakeIO(stdout = '', stderr = '', exitCode: number | null = 0): FakeIO {
  return { stdoutText: stdout, stderrText: stderr, exitCode }
}

describe('ioToExecuteResponse', () => {
  it('combines stdout and stderr', () => {
    const r = ioToExecuteResponse(fakeIO('out', 'err', 1))
    expect(r.output).toBe('out\nerr')
    expect(r.exitCode).toBe(1)
    expect(r.truncated).toBe(false)
  })

  it('returns stdout only when stderr empty', () => {
    expect(ioToExecuteResponse(fakeIO('out', '')).output).toBe('out')
  })

  it('returns stderr only when stdout empty', () => {
    expect(ioToExecuteResponse(fakeIO('', 'err')).output).toBe('err')
  })

  it('returns empty string when both empty', () => {
    expect(ioToExecuteResponse(fakeIO('', '')).output).toBe('')
  })
})

describe('ioToGrepMatches', () => {
  it('parses grep -n output', () => {
    const out = '/a.txt:3:hello\n/b.txt:7:world\n'
    expect(ioToGrepMatches(fakeIO(out))).toEqual([
      { path: '/a.txt', line: 3, text: 'hello' },
      { path: '/b.txt', line: 7, text: 'world' },
    ])
  })

  it('returns empty for empty stdout', () => {
    expect(ioToGrepMatches(fakeIO(''))).toEqual([])
  })

  it('skips lines without parseable line number', () => {
    expect(ioToGrepMatches(fakeIO('/a:notanumber:x\n'))).toEqual([])
  })
})

describe('ioToFileInfos', () => {
  it('parses find output (files and dirs)', () => {
    const out = '/a.txt\n/data/\n/b.csv\n'
    expect(ioToFileInfos(fakeIO(out))).toEqual([
      { path: '/a.txt', is_dir: false },
      { path: '/data', is_dir: true },
      { path: '/b.csv', is_dir: false },
    ])
  })

  it('returns empty for empty stdout', () => {
    expect(ioToFileInfos(fakeIO(''))).toEqual([])
  })
})
