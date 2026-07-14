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
import { shellJoin } from './join.ts'

describe('shellJoin', () => {
  it('leaves safe tokens unquoted', () => {
    expect(shellJoin(['wc', '-l', '/ram/f'])).toBe('wc -l /ram/f')
  })

  it('quotes whitespace', () => {
    expect(shellJoin(['wc', '/ram/a b'])).toBe("wc '/ram/a b'")
  })

  it('quotes command substitution literally', () => {
    expect(shellJoin(['echo', '$(rm -rf /)'])).toBe("echo '$(rm -rf /)'")
  })

  it('escapes single quotes inside a token', () => {
    expect(shellJoin(['echo', "don't"])).toBe("echo 'don'\\''t'")
  })

  it('quotes globs, semicolons, pipes, backticks', () => {
    expect(shellJoin(['echo', '*.txt', 'a;b', 'c|d', '`date`'])).toBe(
      "echo '*.txt' 'a;b' 'c|d' '`date`'",
    )
  })

  it('represents an empty token', () => {
    expect(shellJoin(['echo', ''])).toBe("echo ''")
  })

  it('joins nothing to an empty line', () => {
    expect(shellJoin([])).toBe('')
  })
})
