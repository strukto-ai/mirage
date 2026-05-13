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
  it('returns 0 for kind:io with exitCode 0', () => {
    expect(exitCodeFromResponse({ kind: 'io', exitCode: 0, stdout: '', stderr: '' })).toBe(0)
  })

  it('returns the exit code for kind:io with non-zero exitCode', () => {
    expect(exitCodeFromResponse({ kind: 'io', exitCode: 1, stdout: '', stderr: '' })).toBe(1)
    expect(exitCodeFromResponse({ kind: 'io', exitCode: 42, stdout: '', stderr: '' })).toBe(42)
    expect(exitCodeFromResponse({ kind: 'io', exitCode: 127, stdout: '', stderr: '' })).toBe(127)
  })

  it('clamps exit codes above 255', () => {
    expect(exitCodeFromResponse({ kind: 'io', exitCode: 300, stdout: '', stderr: '' })).toBe(255)
  })

  it('clamps negative exit codes to 0', () => {
    expect(exitCodeFromResponse({ kind: 'io', exitCode: -1, stdout: '', stderr: '' })).toBe(0)
  })

  it('truncates non-integer exit codes', () => {
    expect(exitCodeFromResponse({ kind: 'io', exitCode: 1.9, stdout: '', stderr: '' })).toBe(1)
  })

  it('returns 0 for background submission envelope', () => {
    expect(exitCodeFromResponse({ jobId: 'job_abc', workspaceId: 'ws', submittedAt: 0 })).toBe(0)
  })

  it('returns 0 for kind:provision', () => {
    expect(exitCodeFromResponse({ kind: 'provision', detail: 'ok' })).toBe(0)
  })

  it('returns 0 for kind:raw', () => {
    expect(exitCodeFromResponse({ kind: 'raw', value: 'hi' })).toBe(0)
  })

  it('reads exit code from job detail envelope', () => {
    expect(
      exitCodeFromResponse({
        jobId: 'job_x',
        status: 'done',
        result: { kind: 'io', exitCode: 7, stdout: '', stderr: '' },
        error: null,
      }),
    ).toBe(7)
  })

  it('returns 0 for pending job (no result yet)', () => {
    expect(
      exitCodeFromResponse({
        jobId: 'job_x',
        status: 'pending',
        result: null,
        error: null,
      }),
    ).toBe(0)
  })

  it('returns 0 for running job (no result yet)', () => {
    expect(
      exitCodeFromResponse({
        jobId: 'job_x',
        status: 'running',
        result: null,
        error: null,
      }),
    ).toBe(0)
  })

  it('returns 2 for daemon-side failed job with no result', () => {
    expect(
      exitCodeFromResponse({
        jobId: 'job_x',
        status: 'failed',
        result: null,
        error: 'boom',
      }),
    ).toBe(2)
  })

  it('returns 2 for canceled job with no result', () => {
    expect(
      exitCodeFromResponse({
        jobId: 'job_x',
        status: 'canceled',
        result: null,
        error: null,
      }),
    ).toBe(2)
  })

  it('prefers inner result exit code over status-based fallback', () => {
    expect(
      exitCodeFromResponse({
        jobId: 'job_x',
        status: 'failed',
        result: { kind: 'io', exitCode: 9, stdout: '', stderr: '' },
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

  it('returns 0 when kind:io is present but exitCode is missing or non-numeric', () => {
    expect(exitCodeFromResponse({ kind: 'io', stdout: '', stderr: '' })).toBe(0)
    expect(exitCodeFromResponse({ kind: 'io', exitCode: 'one', stdout: '', stderr: '' })).toBe(0)
    expect(exitCodeFromResponse({ kind: 'io', exitCode: NaN, stdout: '', stderr: '' })).toBe(0)
  })
})
