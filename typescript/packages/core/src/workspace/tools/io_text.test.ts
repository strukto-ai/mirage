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
import type { PolicyDecision } from '../../types.ts'
import { ExecuteResult } from '../workspace/workspace.ts'
import { PolicyDenied } from '../../policy/errors.ts'
import { eisdir } from '../../errors/fs.ts'
import { decode, errorText, ioToStr, replaceText } from './io_text.ts'

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
  const denied: PolicyDecision = {
    kind: 'deny',
    reason: 'no deletes',
    policy: 'RulePolicy',
    askId: null,
  }
  const pending: PolicyDecision = {
    kind: 'pending',
    reason: 'sign-off',
    policy: '',
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

  it('describes a command refusal the output happens to quote', () => {
    // `V=secret; printf 'secrets stay put'; echo "$V" 2>/dev/null`: the
    // bare `Permission denied` was redirected away and the earlier
    // output carries the reason by coincidence; a record is never
    // already said, so the line is still appended.
    const quoted: PolicyDecision = {
      kind: 'deny',
      reason: 'secrets stay put',
      policy: 'DenySecret',
      askId: null,
    }
    expect(ioToStr(new ExecuteResult(enc('secrets stay put'), enc(''), 126, quoted))).toBe(
      'secrets stay put\npolicy denied: secrets stay put\n',
    )
  })
})

describe('replaceText', () => {
  it('replaces the first occurrence and counts every one', () => {
    expect(replaceText('a-a-a', 'a', 'b', false)).toEqual(['b-a-a', 3])
  })

  it('replaces every occurrence under replaceAll', () => {
    expect(replaceText('a-a-a', 'a', 'b', true)).toEqual(['b-b-b', 3])
  })

  it('writes dollar patterns literally', () => {
    expect(replaceText('x=1', '1', "$$ $& $1 $' $`", false)).toEqual(["x=$$ $& $1 $' $`", 1])
    expect(replaceText('1,1', '1', '$&$&', true)).toEqual(['$&$&,$&$&', 2])
  })

  it('reports a miss as a zero count', () => {
    expect(replaceText('abc', 'z', 'y', false)).toEqual(['abc', 0])
  })
})

describe('errorText', () => {
  it('adds the policy line to a plain EACCES', () => {
    const decision: PolicyDecision = {
      kind: 'deny',
      reason: 'sealed',
      policy: '',
      askId: null,
    }
    expect(errorText(new PolicyDenied('Permission denied', '/data/x', decision))).toBe(
      'Error: /data/x: Permission denied\npolicy denied: sealed\n',
    )
    expect(errorText(new Error('No such file or directory'))).toBe(
      'Error: No such file or directory',
    )
    const pathless = Object.assign(new Error('Permission denied'), { code: 'EACCES' })
    expect(errorText(pathless)).toBe('Error: Permission denied')
    expect(errorText(eisdir('Is a directory'))).toBe('Error: Is a directory: Is a directory')
    expect(errorText(undefined)).toBe('Error: undefined')
  })
})
