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
import { exitCodeFromResponse } from './output.ts'

describe('exitCodeFromResponse', () => {
  it('returns 0 for kind:io with exit_code 0', () => {
    expect(exitCodeFromResponse({ kind: 'io', exit_code: 0, stdout: '', stderr: '' })).toBe(0)
  })

  it('returns the exit code for kind:io with non-zero exit_code', () => {
    expect(exitCodeFromResponse({ kind: 'io', exit_code: 1, stdout: '', stderr: '' })).toBe(1)
    expect(exitCodeFromResponse({ kind: 'io', exit_code: 42, stdout: '', stderr: '' })).toBe(42)
    expect(exitCodeFromResponse({ kind: 'io', exit_code: 127, stdout: '', stderr: '' })).toBe(127)
  })

  it('clamps exit codes above 255', () => {
    expect(exitCodeFromResponse({ kind: 'io', exit_code: 300, stdout: '', stderr: '' })).toBe(255)
  })

  it('clamps negative exit codes to 0', () => {
    expect(exitCodeFromResponse({ kind: 'io', exit_code: -1, stdout: '', stderr: '' })).toBe(0)
  })

  it('truncates non-integer exit codes', () => {
    expect(exitCodeFromResponse({ kind: 'io', exit_code: 1.9, stdout: '', stderr: '' })).toBe(1)
  })

  it('returns 0 for background submission envelope', () => {
    expect(exitCodeFromResponse({ job_id: 'job_abc', workspace_id: 'ws', submitted_at: 0 })).toBe(0)
  })

  it('returns 0 for kind:raw', () => {
    expect(exitCodeFromResponse({ kind: 'raw', value: 'hi' })).toBe(0)
  })

  it('reads exit code from job detail envelope', () => {
    expect(
      exitCodeFromResponse({
        job_id: 'job_x',
        status: 'done',
        result: { kind: 'io', exit_code: 7, stdout: '', stderr: '' },
        error: null,
      }),
    ).toBe(7)
  })

  it('returns 0 for pending job (no result yet)', () => {
    expect(
      exitCodeFromResponse({
        job_id: 'job_x',
        status: 'pending',
        result: null,
        error: null,
      }),
    ).toBe(0)
  })

  it('returns 0 for running job (no result yet)', () => {
    expect(
      exitCodeFromResponse({
        job_id: 'job_x',
        status: 'running',
        result: null,
        error: null,
      }),
    ).toBe(0)
  })

  it('returns 2 for daemon-side failed job with no result', () => {
    expect(
      exitCodeFromResponse({
        job_id: 'job_x',
        status: 'failed',
        result: null,
        error: 'boom',
      }),
    ).toBe(2)
  })

  it('returns 2 for canceled job with no result', () => {
    expect(
      exitCodeFromResponse({
        job_id: 'job_x',
        status: 'canceled',
        result: null,
        error: null,
      }),
    ).toBe(2)
  })

  it('prefers inner result exit code over status-based fallback', () => {
    expect(
      exitCodeFromResponse({
        job_id: 'job_x',
        status: 'failed',
        result: { kind: 'io', exit_code: 9, stdout: '', stderr: '' },
        error: null,
      }),
    ).toBe(9)
  })

  it('returns 0 for null, undefined, and non-object inputs', () => {
    expect(exitCodeFromResponse(null)).toBe(0)
    expect(exitCodeFromResponse(undefined)).toBe(0)
    expect(exitCodeFromResponse('string')).toBe(0)
    expect(exitCodeFromResponse(42)).toBe(0)
  })

  it('returns 0 when kind:io is present but exit_code is missing or non-numeric', () => {
    expect(exitCodeFromResponse({ kind: 'io', stdout: '', stderr: '' })).toBe(0)
    expect(exitCodeFromResponse({ kind: 'io', exit_code: 'one', stdout: '', stderr: '' })).toBe(0)
    expect(exitCodeFromResponse({ kind: 'io', exit_code: NaN, stdout: '', stderr: '' })).toBe(0)
  })
})
