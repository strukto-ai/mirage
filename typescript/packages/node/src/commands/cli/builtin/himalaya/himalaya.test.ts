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
import { cliSpecFor, materialize, type IOResult } from '@struktoai/mirage-core'
import { EmailAccessor } from '../../../../accessor/email.ts'
import { Workspace } from '../../../../workspace.ts'
import { HIMALAYA } from './index.ts'
import { listEnvelopes } from './list.ts'
import { send } from './send.ts'

vi.mock('../../../../core/email/send.ts', () => ({
  sendMessage: vi.fn((_config: unknown, to: string, subject: string) =>
    Promise.resolve({ status: 'sent', to, subject }),
  ),
  replyMessage: vi.fn(),
  replyAllMessage: vi.fn(),
  forwardMessage: vi.fn(),
}))

vi.mock('../../../../core/email/search.ts', () => ({
  searchMessages: vi.fn(() => Promise.resolve(['1', '2'])),
}))

vi.mock('../../../../core/email/_client.ts', () => ({
  fetchMessage: vi.fn(),
  fetchHeaders: vi.fn((_accessor: unknown, _folder: string, uids: string[]) =>
    Promise.resolve(uids.map((uid) => ({ uid, subject: `s${uid}` }))),
  ),
}))

const CONFIG = {
  imapHost: 'h',
  imapPort: 993,
  smtpHost: 'h',
  smtpPort: 587,
  username: 'u',
  password: 'p',
  useSsl: false,
  maxMessages: 200,
}

function leaf(...path: string[]) {
  let node = HIMALAYA
  for (const name of path) {
    const child = node.subcommands.find((c) => c.name === name)
    if (child === undefined) throw new Error(`no subcommand ${name}`)
    node = child
  }
  return node
}

describe('himalaya tree', () => {
  it('matches the himalaya vocabulary', () => {
    expect(HIMALAYA.name).toBe('himalaya')
    expect(HIMALAYA.subcommands.map((g) => g.name)).toEqual(['envelope', 'message'])
    expect(leaf('envelope').subcommands.map((v) => v.name)).toEqual(['list'])
    expect(leaf('message').subcommands.map((v) => v.name)).toEqual([
      'read',
      'send',
      'reply',
      'forward',
    ])
  })

  it('classifies writes and pins required flags', () => {
    expect(leaf('envelope', 'list').write).toBe(false)
    expect(leaf('message', 'read').write).toBe(false)
    for (const verb of ['send', 'reply', 'forward']) {
      expect(leaf('message', verb).write).toBe(true)
    }
    const required = leaf('message', 'send')
      .options.filter((o) => o.required)
      .map((o) => o.long)
    expect(required.sort()).toEqual(['--body', '--subject', '--to'])
  })

  it('registers itself for YAML resolution at import time', () => {
    expect(cliSpecFor('himalaya')).toBe(HIMALAYA)
  })

  it('applies config defaults through the zod model', () => {
    const model = HIMALAYA.configModel
    if (model === null || typeof model === 'function') throw new Error('expected zod model')
    const parsed = model.parse({
      imapHost: 'h',
      smtpHost: 'h',
      username: 'u',
      password: 'p',
    })
    expect(parsed.imapPort).toBe(993)
    expect(parsed.smtpPort).toBe(587)
    expect(parsed.useSsl).toBe(true)
    expect(parsed.maxMessages).toBe(200)
  })
})

describe('himalaya verbs', () => {
  it('send renders the send result as JSON', async () => {
    const [out, io] = (await send(CONFIG, [], [], {
      stdin: null,
      flags: { to: 'a@b.com', subject: 'Hi', body: 'yo' },
    })) as [Uint8Array, IOResult]
    expect(io.exitCode).toBe(0)
    expect(JSON.parse(new TextDecoder().decode(await materialize(out)))).toEqual({
      status: 'sent',
      to: 'a@b.com',
      subject: 'Hi',
    })
  })

  it('list closes its per-call accessor', async () => {
    const closeSpy = vi.spyOn(EmailAccessor.prototype, 'close').mockResolvedValue()
    const [out] = (await listEnvelopes(CONFIG, [], [], {
      stdin: null,
      flags: {},
    })) as [Uint8Array, IOResult]
    const rows = JSON.parse(new TextDecoder().decode(await materialize(out))) as {
      uid: string
    }[]
    expect(rows.map((r) => r.uid)).toEqual(['1', '2'])
    expect(closeSpy).toHaveBeenCalledTimes(1)
    closeSpy.mockRestore()
  })
})

describe('himalaya dispatch', () => {
  it('runs an installed tree end to end and exits 2 on missing required', async () => {
    const ws = new Workspace({})
    ws.registerCli('himalaya', HIMALAYA, {
      imapHost: 'h',
      smtpHost: 'h',
      username: 'u',
      password: 'p',
    })
    let io = await ws.execute('himalaya message send --to a@b.com --subject Hi --body yo')
    expect(io.exitCode).toBe(0)
    expect(JSON.parse(new TextDecoder().decode(io.stdout))).toEqual({
      status: 'sent',
      to: 'a@b.com',
      subject: 'Hi',
    })
    io = await ws.execute('himalaya message send --subject Hi --body yo')
    expect(io.exitCode).toBe(2)
    expect(new TextDecoder().decode(io.stderr)).toContain("option '--to' is required")
    await ws.close()
  })
})
