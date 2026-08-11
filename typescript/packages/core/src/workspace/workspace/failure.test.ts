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

import { CommandTimeoutError } from '../../commands/builtin/utils/limit.ts'
import { UsageError } from '../../commands/errors.ts'
import { ContentDriftError } from '../snapshot/drift.ts'
import { failureResult, isControlFlowError } from './failure.ts'

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

describe('failureResult', () => {
  it('reports 124 with the timeout message', () => {
    const result = failureResult(new CommandTimeoutError('sleep 99', 2))
    expect(result.exitCode).toBe(124)
    expect(decode(result.stderr)).toBe('sleep 99: timed out after 2s\n')
  })

  it('keeps a usage error exit code', () => {
    const result = failureResult(new UsageError('ls: bad option', 2))
    expect(result.exitCode).toBe(2)
    expect(decode(result.stderr)).toBe('ls: bad option\n')
  })

  it('falls back to exit 1 for unknown errors', () => {
    const result = failureResult(new Error('boom'))
    expect(result.exitCode).toBe(1)
    expect(decode(result.stderr)).toBe('boom\n')
  })
})

describe('isControlFlowError', () => {
  it('propagates drift and abort, folds the rest', () => {
    expect(isControlFlowError(new ContentDriftError('/x', 'a', 'b'))).toBe(true)
    expect(isControlFlowError(new DOMException('execute aborted', 'AbortError'))).toBe(true)
    expect(isControlFlowError(new CommandTimeoutError('x', 1))).toBe(false)
    expect(isControlFlowError(new Error('boom'))).toBe(false)
  })
})
