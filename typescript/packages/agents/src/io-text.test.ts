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
import type { Refusal } from '@struktoai/mirage-core/types'
import { ExecuteResult } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { decode, ioToStr, withRefusal } from './io-text.ts'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('decode', () => {
  it('returns empty string for null/undefined', () => {
    expect(decode(null)).toBe('')
    expect(decode(undefined)).toBe('')
  })

  it('decodes utf-8 bytes', () => {
    expect(decode(enc('hello'))).toBe('hello')
  })

  it('replaces invalid utf-8', () => {
    expect(decode(new Uint8Array([0xff]))).toBe('�')
  })
})

describe('ioToStr', () => {
  it('returns stdout only', () => {
    expect(ioToStr(new ExecuteResult(enc('out'), enc(''), 0))).toBe('out')
  })

  it('returns stderr only', () => {
    expect(ioToStr(new ExecuteResult(enc(''), enc('err'), 1))).toBe('err')
  })

  it('combines stdout and stderr', () => {
    expect(ioToStr(new ExecuteResult(enc('out'), enc('err'), 1))).toBe('out\nerr')
  })
})

describe('ioToStr with a refusal', () => {
  const denied: Refusal = {
    kind: 'deny',
    reason: 'no deletes',
    policy: 'RulePolicy',
    scope: 'command',
    askId: null,
  }
  const pending: Refusal = {
    kind: 'pending',
    reason: 'sign-off',
    policy: '',
    scope: 'command',
    askId: 'a1',
  }

  it('appends the refusal after stderr', () => {
    expect(ioToStr(new ExecuteResult(enc(''), enc('rm: Permission denied\n'), 126, denied))).toBe(
      'rm: Permission denied\npolicy denied: no deletes\n',
    )
  })

  it('starts a line for the refusal when needed', () => {
    expect(ioToStr(new ExecuteResult(enc('partial'), enc(''), 126, pending))).toBe(
      'partial\nrequires approval: sign-off (ask a1)\n',
    )
    expect(ioToStr(new ExecuteResult(enc(''), enc(''), 126, pending))).toBe(
      'requires approval: sign-off (ask a1)\n',
    )
  })

  it('leaves an operand refusal alone', () => {
    // The stderr line already names the reason, GNU-style.
    const operand: Refusal = {
      kind: 'deny',
      reason: "cannot remove 'x': keys",
      policy: 'RulePolicy',
      scope: 'operand',
      askId: null,
    }
    expect(
      ioToStr(new ExecuteResult(enc(''), enc("rm: cannot remove 'x': keys\n"), 1, operand)),
    ).toBe("rm: cannot remove 'x': keys\n")
  })

  it('describes an operand refusal whose line was redirected away', () => {
    // `cat /protected 2>/dev/null`: the GNU line is gone, so the record
    // is the only reason left to hand over.
    const operand: Refusal = {
      kind: 'deny',
      reason: '/protected: frozen',
      policy: 'Frozen',
      scope: 'operand',
      askId: null,
    }
    expect(ioToStr(new ExecuteResult(enc(''), enc(''), 1, operand))).toBe(
      'policy denied: /protected: frozen\n',
    )
    expect(withRefusal('', operand)).toBe('policy denied: /protected: frozen\n')
  })

  it('describes a command refusal the output happens to quote', () => {
    // `V=secret; printf 'secrets stay put'; echo "$V" 2>/dev/null`: the
    // bare `Permission denied` was redirected away and the earlier
    // output carries the reason by coincidence; a command-scoped record
    // is never already said, so the line is still appended.
    const quoted: Refusal = {
      kind: 'deny',
      reason: 'secrets stay put',
      policy: 'DenySecret',
      scope: 'command',
      askId: null,
    }
    expect(ioToStr(new ExecuteResult(enc('secrets stay put'), enc(''), 126, quoted))).toBe(
      'secrets stay put\npolicy denied: secrets stay put\n',
    )
  })

  it('describes an operand refusal the output only quotes', () => {
    const operand: Refusal = {
      kind: 'deny',
      reason: '/protected: frozen',
      policy: 'Frozen',
      scope: 'operand',
      askId: null,
    }
    expect(
      ioToStr(new ExecuteResult(enc('note: /protected: frozen for now\n'), enc(''), 1, operand)),
    ).toBe('note: /protected: frozen for now\npolicy denied: /protected: frozen\n')
  })

  it('trusts the reason wherever the line landed', () => {
    // `2>&1` moved the GNU line onto stdout; the text still says why.
    const operand: Refusal = {
      kind: 'deny',
      reason: '/protected: frozen',
      policy: 'Frozen',
      scope: 'operand',
      askId: null,
    }
    expect(ioToStr(new ExecuteResult(enc('cat: /protected: frozen\n'), enc(''), 1, operand))).toBe(
      'cat: /protected: frozen\n',
    )
  })
})
