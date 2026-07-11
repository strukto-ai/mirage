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
import { missingValueError, unknownOptionError, usageExitCode } from './usage.ts'

const td = new TextDecoder()

describe('usageExitCode', () => {
  it('matches GNU per-tool codes', () => {
    expect(usageExitCode('cat')).toBe(1)
    expect(usageExitCode('grep')).toBe(2)
    expect(usageExitCode('ls')).toBe(2)
    expect(usageExitCode('sort')).toBe(2)
    expect(usageExitCode('tar')).toBe(64)
  })
})

describe('unknownOptionError', () => {
  it('long options report the full token', () => {
    const [msg, code] = unknownOptionError('cat', '--bogus=x')
    expect(td.decode(msg)).toBe(
      "cat: unrecognized option '--bogus=x'\nTry 'cat --help' for more information.\n",
    )
    expect(code).toBe(1)
  })

  it('short options report the char', () => {
    const [msg, code] = unknownOptionError('grep', 'Y')
    expect(td.decode(msg)).toBe(
      "grep: invalid option -- 'Y'\nTry 'grep --help' for more information.\n",
    )
    expect(code).toBe(2)
  })

  it('find uses predicate wording', () => {
    const [msg, code] = unknownOptionError('find', '--bogus')
    expect(td.decode(msg)).toBe("find: unknown predicate `--bogus'\n")
    expect(code).toBe(1)
  })
})

describe('missingValueError', () => {
  it('short and long shapes', () => {
    const [shortMsg, shortCode] = missingValueError('grep', 'm')
    expect(td.decode(shortMsg)).toContain("grep: option requires an argument -- 'm'\n")
    expect(shortCode).toBe(2)
    const [longMsg, longCode] = missingValueError('du', '--max-depth')
    expect(td.decode(longMsg)).toContain("du: option '--max-depth' requires an argument\n")
    expect(longCode).toBe(1)
  })
})
