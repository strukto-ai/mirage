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
import { NotionAPIError } from '../../../../core/notion/_client.ts'
import { IOResult, type ByteSource } from '../../../../io/types.ts'
import type { CLISpec } from '../../types.ts'
import { NTN } from './index.ts'
import { GUARDED, HintedAPIError, apiFailure, guarded, sourceHint } from './failure.ts'

const DEC = new TextDecoder()

// Every line here was printed by ntn 0.21.9 against a server returning that
// status with Notion's own error envelope. The two shapes upstream has for a
// missing message (it echoes the raw body instead) are absent on purpose: the
// client synthesizes a message before raising, so they cannot be reached.
const PROBED: [number, string, string, string][] = [
  [
    400,
    'validation_error',
    'block_id should be a valid uuid.',
    'error: Public API request failed (400 Bad Request validation_error): block_id should be a valid uuid.\n',
  ],
  [
    403,
    'restricted_resource',
    'sample message.',
    'error: Public API request failed (403 Forbidden restricted_resource): sample message.\n',
  ],
  [
    404,
    'object_not_found',
    'Could not find block with ID: x.',
    'error: Public API request failed (404 Not Found object_not_found): Could not find block with ID: x.\n',
  ],
  [
    409,
    'conflict_error',
    'sample message.',
    'error: Public API request failed (409 Conflict conflict_error): sample message.\n',
  ],
  [
    429,
    'rate_limited',
    'sample message.',
    'error: Public API request failed (429 Too Many Requests rate_limited): sample message.\n',
  ],
  [
    500,
    'internal_server_error',
    'sample message.',
    'error: Public API request failed (500 Internal Server Error internal_server_error): sample message.\n',
  ],
  [
    502,
    'bad_gateway',
    'sample message.',
    'error: Public API request failed (502 Bad Gateway bad_gateway): sample message.\n',
  ],
  [
    503,
    'service_unavailable',
    'sample message.',
    'error: Public API request failed (503 Service Unavailable service_unavailable): sample message.\n',
  ],
  [
    504,
    'gateway_timeout',
    'sample message.',
    'error: Public API request failed (504 Gateway Timeout gateway_timeout): sample message.\n',
  ],
]

// An absent handler is null here, not undefined, so the walk tests for a
// callable: `!== undefined` matched the root and made the whole check vacuous.
function leaves(node: CLISpec, path: string[]): [string, CLISpec][] {
  const here = [...path, node.name]
  if (typeof node.fn === 'function') return [[here.join(' '), node]]
  return node.subcommands.flatMap((child) => leaves(child, here))
}

describe('ntn api failures speak upstream', () => {
  it.each(PROBED)('renders %i like the real CLI', (status, code, message, stderr) => {
    expect(apiFailure(new NotionAPIError(message, status, code))).toEqual([stderr, 5])
  })

  it('drops the parenthesis and exits 4 on 401', () => {
    // Upstream's one special case: a token problem is the user's to fix, so it
    // answers with a hint instead of itemizing a status it already implied.
    const failed = new NotionAPIError('API token is invalid.', 401, 'unauthorized')
    expect(apiFailure(failed)).toEqual([
      'error: Public API request failed: API token is invalid.\n' +
        '  hint: Set NOTION_API_TOKEN, or run `ntn login` to reuse a saved workspace token.\n',
      4,
    ])
  })

  it('keeps the status and reason when the body carried no code', () => {
    expect(apiFailure(new NotionAPIError('no code here.', 404))).toEqual([
      'error: Public API request failed (404 Not Found): no code here.\n',
      5,
    ])
  })

  it('keeps the number and drops the phrase for an unlisted status', () => {
    expect(apiFailure(new NotionAPIError('odd one.', 418, 'teapot'))).toEqual([
      'error: Public API request failed (418 teapot): odd one.\n',
      5,
    ])
  })

  it('rides a verb hint on the same render', () => {
    const base = new NotionAPIError(
      'Could not find data source with ID: y.',
      404,
      'object_not_found',
    )
    expect(apiFailure(new HintedAPIError(base, sourceHint('y')))).toEqual([
      'error: Public API request failed (404 Not Found object_not_found): ' +
        'Could not find data source with ID: y.\n  hint: Could not find a data source or ' +
        'database with ID `y`. Check that the ID or URL points to a data source or database ' +
        'shared with your integration.\n',
      5,
    ])
  })
})

describe('guarded', () => {
  it('renders an API error and passes anything else through', async () => {
    const wrapped = guarded(() => {
      throw new NotionAPIError('boom.', 404, 'object_not_found')
    })
    const [stdout, io]: [ByteSource | null, IOResult] = await wrapped({} as never)
    expect(stdout).toBeNull()
    expect(io.exitCode).toBe(5)
    expect(DEC.decode(io.stderr as Uint8Array)).toContain('404 Not Found object_not_found')

    const other = guarded(() => {
      throw new TypeError('not an API failure')
    })
    await expect(other({} as never)).rejects.toThrow(TypeError)
  })

  it('returns a successful verb untouched', async () => {
    const ok = new IOResult()
    const wrapped = guarded(() => [null, ok])
    expect(await wrapped({} as never)).toEqual([null, ok])
  })
})

describe('the tree', () => {
  it('guards every leaf', () => {
    // The wrap is the whole mechanism, so a verb added without it still runs,
    // still exits 0 on success, and simply reports its API failures in the
    // executor's generic shape, which nothing notices until someone reads a
    // 404 from it.
    const unguarded = leaves(NTN, [])
      .filter(([, leaf]) => (leaf.fn as unknown as Record<symbol, unknown>)[GUARDED] !== true)
      .map(([name]) => name)
    expect(unguarded).toEqual([])
  })

  it('finds the leaves it claims to check', () => {
    // Guards the guard: an empty walk would make the assertion above vacuous.
    expect(leaves(NTN, []).map(([name]) => name)).toContain('ntn api')
    expect(leaves(NTN, []).length).toBe(9)
  })
})
