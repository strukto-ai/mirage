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

import { describe, expect, it, vi } from 'vitest'
import { exitCodeFromResponse, handleList } from './output.ts'

describe('handleList', () => {
  it('reads the items of a list answer', async () => {
    const r = new Response(JSON.stringify({ items: [{ id: 'a' }] }), { status: 200 })
    expect(await handleList(r)).toEqual([{ id: 'a' }])
  })

  it('exits 2 on an answer without items', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`)
    })
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await expect(handleList(new Response('[]', { status: 200 }))).rejects.toThrow('exit 2')
      expect(stderr).toHaveBeenCalledWith('the server answered no list\n')
    } finally {
      exit.mockRestore()
      stderr.mockRestore()
    }
  })
})

describe('exitCodeFromResponse', () => {
  it.each([
    ['zero', 0, 0],
    ['one', 1, 1],
    ['nonzero', 42, 42],
    ['command missing', 127, 127],
    ['clamp high', 300, 255],
    ['clamp negative', -1, 0],
    ['truncate float', 1.9, 1],
    ['nonnumeric', 'one', 0],
    ['NaN', NaN, 0],
  ])('IO exit code: %s', (_name, code, expected) => {
    expect(exitCodeFromResponse({ exit_code: code, stdout: '', stderr: '' })).toBe(expected)
  })

  it.each([
    {
      status: 'done',
      result: { exit_code: 7, stdout: '', stderr: '' },
      error: null,
      expected: 7,
    },
    { status: 'pending', result: null, error: null, expected: 0 },
    { status: 'running', result: null, error: null, expected: 0 },
    { status: 'failed', result: null, error: 'boom', expected: 2 },
    { status: 'canceled', result: null, error: null, expected: 2 },
    {
      status: 'failed',
      result: { exit_code: 9, stdout: '', stderr: '' },
      error: null,
      expected: 9,
    },
  ])('$status job returns $expected', ({ status, result, error, expected }) => {
    expect(exitCodeFromResponse({ job_id: 'job_x', status, result, error })).toBe(expected)
  })

  it.each([
    ['background submission', { job_id: 'job_abc', workspace_id: 'ws', submitted_at: 0 }],
    ['no exit code field', { value: 'hi' }],
    ['missing exit code', { stdout: '', stderr: '' }],
    ['null', null],
    ['undefined', undefined],
    ['string', 'string'],
    ['number', 42],
  ])('%s returns zero', (_name, response) => {
    expect(exitCodeFromResponse(response)).toBe(0)
  })
})
