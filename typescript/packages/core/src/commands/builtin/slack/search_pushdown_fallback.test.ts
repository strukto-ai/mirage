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
import { RAMIndexCacheStore } from '../../../cache/index/ram.ts'
import { SlackApiError, type SlackResponse } from '../../../core/slack/_client.ts'
import { materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { FakeSlackTransport, makeFakeResource, seedChannel } from './_test_util.ts'
import { SLACK_GREP } from './grep.ts'
import { SLACK_RG } from './rg.ts'

const DEC = new TextDecoder()

async function runGrep(
  paths: PathSpec[],
  texts: string[],
  options: { transport: FakeSlackTransport; index: RAMIndexCacheStore },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cmd = SLACK_GREP[0]
  if (cmd === undefined) throw new Error('grep not registered')
  const resource = makeFakeResource(options.transport)
  const result = await cmd.fn(resource.accessor, paths, texts, {
    stdin: null,
    flags: { args_l: true },
    filetypeFns: null,
    cwd: '/',
    resource,
    index: options.index,
  })
  if (result === null) return { stdout: '', stderr: '', exitCode: 0 }
  const [out, io] = result
  const stdoutBytes =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  const stderrBytes = await io.materializeStderr()
  return {
    stdout: DEC.decode(stdoutBytes),
    stderr: DEC.decode(stderrBytes),
    exitCode: io.exitCode,
  }
}

async function runRg(
  paths: PathSpec[],
  texts: string[],
  options: { transport: FakeSlackTransport; index: RAMIndexCacheStore },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cmd = SLACK_RG[0]
  if (cmd === undefined) throw new Error('rg not registered')
  const resource = makeFakeResource(options.transport)
  const result = await cmd.fn(resource.accessor, paths, texts, {
    stdin: null,
    flags: { args_l: true },
    filetypeFns: null,
    cwd: '/',
    resource,
    index: options.index,
  })
  if (result === null) return { stdout: '', stderr: '', exitCode: 0 }
  const [out, io] = result
  const stdoutBytes =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  const stderrBytes = await io.materializeStderr()
  return {
    stdout: DEC.decode(stdoutBytes),
    stderr: DEC.decode(stderrBytes),
    exitCode: io.exitCode,
  }
}

describe('slack grep: search push-down fallback', () => {
  it('emits SLACK_USER_TOKEN hint when search.messages returns not_allowed_token_type', async () => {
    const idx = new RAMIndexCacheStore()
    await seedChannel(idx, '/mnt/slack', 'general__C1', 'C1', { dates: ['2024-01-01'] })
    let searchCalled = false
    const transport = new FakeSlackTransport((endpoint): SlackResponse => {
      if (endpoint === 'search.messages' || endpoint === 'search.files') {
        searchCalled = true
        throw new SlackApiError(endpoint, 'not_allowed_token_type')
      }
      if (endpoint === 'conversations.history') {
        return { ok: true, messages: [{ ts: '1.0', text: 'hello world' }] }
      }
      return { ok: true }
    })
    const out = await runGrep(
      [
        new PathSpec({
          original: '/mnt/slack/channels/general__C1',
          directory: '/mnt/slack/channels/general__C1',
          resolved: false,
          prefix: '/mnt/slack',
        }),
      ],
      ['hello'],
      { transport, index: idx },
    )
    expect(searchCalled).toBe(true)
    expect(out.stderr).toContain('native search push-down failed')
    expect(out.stderr).toContain('SLACK_USER_TOKEN')
    expect(out.stderr).toContain('search:read')
  })
})

describe('slack rg: search push-down fallback', () => {
  it('emits SLACK_USER_TOKEN hint when search.messages returns missing_scope', async () => {
    const idx = new RAMIndexCacheStore()
    await seedChannel(idx, '/mnt/slack', 'general__C1', 'C1', { dates: ['2024-01-01'] })
    const transport = new FakeSlackTransport((endpoint): SlackResponse => {
      if (endpoint === 'search.messages' || endpoint === 'search.files') {
        throw new SlackApiError(endpoint, 'missing_scope', 'search:read', 'channels:read')
      }
      if (endpoint === 'conversations.history') {
        return { ok: true, messages: [{ ts: '1.0', text: 'hi' }] }
      }
      return { ok: true }
    })
    const out = await runRg(
      [
        new PathSpec({
          original: '/mnt/slack/channels/general__C1',
          directory: '/mnt/slack/channels/general__C1',
          resolved: false,
          prefix: '/mnt/slack',
        }),
      ],
      ['hi'],
      { transport, index: idx },
    )
    expect(out.stderr).toContain('SLACK_USER_TOKEN')
    expect(out.stderr).toContain('search:read')
  })
})
