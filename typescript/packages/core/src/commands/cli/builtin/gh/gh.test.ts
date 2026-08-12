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
import type * as AccessorModule from './accessor.ts'
import type { GitHubTransport } from '../../../../core/github/_client.ts'
import { cliSpecFor } from '../../specs.ts'
import type { CommandFnResult } from '../../../config.ts'
import type { CLIInvocation } from '../../types.ts'
import { GH } from './index.ts'
import { api } from './api.ts'
import { fork, rename, view } from './repo.ts'

const DEC = new TextDecoder()

interface Call {
  method: string
  path: string
  body?: unknown
  params?: Record<string, string>
}

const CALLS: Call[] = []
let REPLY: unknown = {}

class FakeTransport implements GitHubTransport {
  get(path: string, params?: Record<string, string>): Promise<unknown> {
    return this.request('GET', path, undefined, params)
  }

  request(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string>,
  ): Promise<unknown> {
    const call: Call = { method, path }
    if (body !== undefined) call.body = body
    if (params !== undefined) call.params = params
    CALLS.push(call)
    return Promise.resolve(REPLY)
  }
}

vi.mock('./accessor.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof AccessorModule>()
  return { ...actual, ghTransport: () => new FakeTransport() }
})

function inv(
  texts: string[],
  flags: CLIInvocation['flags'] = {},
  config: unknown = { token: 't' },
): CLIInvocation {
  return { config, argv: [], paths: [], texts, flags, stdin: null, env: {} }
}

function text(result: CommandFnResult): string {
  if (result === null) throw new Error('expected a result tuple')
  return DEC.decode(result[0] as Uint8Array)
}

function reset(reply: unknown = {}): void {
  CALLS.length = 0
  REPLY = reply
}

describe('gh tree', () => {
  it('registers itself under the grammar gh uses', () => {
    expect(cliSpecFor('gh')).toBe(GH)
    expect(GH.subcommands.map((c) => c.name)).toEqual(['repo', 'api'])
    const repo = GH.subcommands.find((c) => c.name === 'repo')
    expect(repo?.subcommands.map((c) => c.name)).toEqual(['view', 'fork', 'rename'])
  })
})

describe('gh repo', () => {
  it('views the repository the operand names', async () => {
    reset({ full_name: 'o/r' })
    await view(inv(['o/r']))
    expect(CALLS).toEqual([{ method: 'GET', path: '/repos/o/r' }])
  })

  it('falls back to the install repo when no operand is given', async () => {
    reset({ full_name: 'cfg/repo' })
    await view(inv([], {}, { token: 't', repo: 'cfg/repo' }))
    expect(CALLS[0]?.path).toBe('/repos/cfg/repo')
  })

  it('refuses a line with no repository anywhere', async () => {
    reset()
    await expect(view(inv([]))).rejects.toThrow(/no repository given/)
  })

  it('refuses a repository that is not OWNER/REPO', async () => {
    reset()
    await expect(view(inv(['justaname']))).rejects.toThrow(/OWNER\/REPO/)
  })

  it('names the fork at creation time when --fork-name is given', async () => {
    reset({ full_name: 'me/renamed' })
    const out = await fork(inv(['o/r'], { fork_name: 'renamed' }))
    expect(CALLS).toEqual([{ method: 'POST', path: '/repos/o/r/forks', body: { name: 'renamed' } }])
    expect(out === null ? '' : text(out)).toContain('me/renamed')
  })

  it('forks under the source name when it is not', async () => {
    reset({ full_name: 'me/r' })
    await fork(inv(['o/r']))
    expect(CALLS[0]?.body).toEqual({})
  })

  // gh takes the new name as the operand and the repository to rename as
  // -R, which is the reverse of what the shape of the line suggests.
  it('renames the -R repository to the operand', async () => {
    reset({ full_name: 'me/after' })
    await rename(inv(['after'], { repo: 'me/before' }))
    expect(CALLS).toEqual([{ method: 'PATCH', path: '/repos/me/before', body: { name: 'after' } }])
  })
})

describe('gh api', () => {
  it('is a GET with no fields, and sends them as query parameters', async () => {
    reset({ ok: true })
    await api(inv(['repos/o/r/contents/x'], { raw_field: ['ref=master'], method: 'GET' }))
    expect(CALLS[0]).toEqual({
      method: 'GET',
      path: '/repos/o/r/contents/x',
      params: { ref: 'master' },
    })
  })

  it('is a POST once a field is given', async () => {
    reset({})
    await api(inv(['repos/o/r/issues'], { raw_field: ['title=hi'] }))
    expect(CALLS[0]?.method).toBe('POST')
  })

  it('sends -f verbatim and reads -F as JSON types', async () => {
    reset({})
    await api(
      inv(['x'], {
        method: 'PUT',
        raw_field: ['a=1'],
        field: ['b=2', 'c=true', 'd=null', 'e=text'],
      }),
    )
    expect(CALLS[0]?.body).toEqual({ a: '1', b: 2, c: true, d: null, e: 'text' })
  })

  it('keeps everything after the first = in the value', async () => {
    reset({})
    await api(inv(['x'], { raw_field: ['content=YQ==\n'] }))
    expect(CALLS[0]?.body).toEqual({ content: 'YQ==\n' })
  })

  it('takes an endpoint with or without a leading slash', async () => {
    reset({})
    await api(inv(['/user']))
    expect(CALLS[0]?.path).toBe('/user')
  })

  it('refuses a field that is not key=value', async () => {
    reset({})
    await expect(api(inv(['x'], { raw_field: ['nope'] }))).rejects.toThrow(/key=value/)
  })
})
