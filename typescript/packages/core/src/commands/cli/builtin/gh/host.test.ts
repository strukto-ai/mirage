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
import { context } from '../../../../../tests/workspace/fixtures/context.ts'
import { GitHubAccount } from '../../../../accessor/github.ts'
import type { ApiResponse } from '../../../../core/api/client.ts'
import {
  GitHubApiError,
  GitHubConnectionError,
  type GitHubTransport,
} from '../../../../core/github/client.ts'
import type { GhConfig } from '../../../../core/github/config.ts'
import { materialize, type IOResult } from '../../../../io/types.ts'
import type { Context } from '../../../config.ts'
import { CommandSpec } from '../../../spec/types.ts'
import { runLeaf } from './host.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()

class FakeTransport implements GitHubTransport {
  readonly calls: [string, string][] = []

  constructor(private readonly reply: unknown) {}

  get(): Promise<unknown> {
    return Promise.reject(new Error('expected a raw call'))
  }

  request(): Promise<unknown> {
    return Promise.reject(new Error('expected a raw call'))
  }

  requestRaw(method: string, path: string): Promise<ApiResponse> {
    this.calls.push([method, path])
    if (this.reply instanceof Error) return Promise.reject(this.reply)
    return Promise.resolve({
      data: ENC.encode(JSON.stringify(this.reply)),
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}

function account(transport: GitHubTransport): GitHubAccount {
  return new GitHubAccount({ token: 't', repo: 'o/r' } as GhConfig, transport)
}

function ctx(flags: Context['flags'] = {}): Context {
  return { ...context(), flags, argv: [], spec: new CommandSpec({ name: 'leaf' }) }
}

async function run(
  transport: GitHubTransport,
  leaf: string,
  texts: string[],
  flags: Context['flags'] = {},
): Promise<[string, IOResult]> {
  const result = await runLeaf(leaf, account(transport), [], texts, ctx(flags))
  if (result === null) throw new Error('no answer')
  const [out, io] = result
  return [DEC.decode(await materialize(out)), io]
}

describe('runLeaf', () => {
  it('runs a subcommand through the host call', async () => {
    const transport = new FakeTransport({
      data: { repository: { pullRequest: { number: 5, title: 't', state: 'OPEN', body: 'b' } } },
    })
    const [out] = await run(transport, 'pr view', ['5'])
    expect(out.split('\n')[0]).toBe('title:\tt')
    expect(transport.calls[0]).toEqual(['POST', 'graphql'])
  })

  it('surfaces a failed call as the error the leaf voice words', async () => {
    const transport = new FakeTransport(
      new GitHubApiError(
        'Not Found',
        404,
        '{"message": "Not Found"}',
        'https://api.github.com/graphql',
        { 'content-type': 'application/json' },
      ),
    )
    const [, io] = await run(transport, 'pr view', ['5'])
    expect(io.exitCode).toBe(1)
    expect(DEC.decode(io.stderr as Uint8Array)).toBe(
      'HTTP 404: Not Found (https://api.github.com/graphql)\n',
    )
  })

  it('surfaces a connection failure the same way', async () => {
    const transport = new FakeTransport(new GitHubConnectionError('no route'))
    const [, io] = await run(transport, 'pr view', ['5'])
    expect(DEC.decode(io.stderr as Uint8Array)).toBe('no route\n')
  })

  it('keeps a usage error in its own words', async () => {
    const transport = new FakeTransport({})
    const [, io] = await run(transport, 'repo delete', ['o/r'])
    expect(io.exitCode).toBe(1)
    expect(DEC.decode(io.stderr as Uint8Array)).toBe(
      '--yes required when not running interactively\n\nUsage:  gh repo delete [flags]\n',
    )
    expect(transport.calls).toEqual([])
  })

  it('keeps output printed before a jq failure', async () => {
    const transport = new FakeTransport({ a: 1 })
    const [out, io] = await run(transport, 'api', ['/x'], { jq: '.a, error("no")' })
    expect(out).toBe('1\n')
    expect(io.exitCode).toBe(1)
    expect(DEC.decode(io.stderr as Uint8Array)).toBe('error: no\n')
  })

  it('warns on stderr and still succeeds', async () => {
    const issue = { __typename: 'Issue', number: 1, state: 'OPEN', title: 't' }
    const transport = new FakeTransport({
      data: { repository: { hasIssuesEnabled: true, issue } },
    })
    const [, io] = await run(transport, 'issue reopen', ['1'])
    expect(io.exitCode).toBe(0)
    expect(DEC.decode(io.stderr as Uint8Array)).toBe('! Issue o/r#1 (t) is already open\n')
  })
})
