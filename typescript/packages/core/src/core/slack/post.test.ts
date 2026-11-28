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

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { COMPLETE, POST, SlackWorkspace, UPLOAD_URL } from '../../../tests/core/slack/workspace.ts'
import { postMessage, replyToThread, uploadFile } from './post.ts'

let origin = ''
let workspace: SlackWorkspace

beforeAll(async () => {
  origin = await serve('slack')
})

beforeEach(async () => {
  workspace = new SlackWorkspace(origin)
  await workspace.reset()
})

afterEach(async () => {
  await workspace.close()
})

// "lunch at noon" in general, which ana reacted to with a rocket.
const LUNCH = '1762214460.000001'

describe('postMessage', () => {
  it('POSTs to chat.postMessage with channel and text', async () => {
    const out = await postMessage(workspace.accessor(), 'C1', 'hello')
    expect(await workspace.run.bodies('POST', POST)).toEqual([{ channel: 'C1', text: 'hello' }])
    expect(await workspace.run.params('POST', POST)).toEqual([{}])
    const ts = String(out.ts)
    expect(out).toMatchObject({ ok: true })
    expect((await workspace.history('C1'))[0]).toMatchObject({ ts, text: 'hello' })
  })
})

describe('replyToThread', () => {
  it('POSTs with thread_ts to chat.postMessage', async () => {
    const out = await replyToThread(workspace.accessor(), 'C1', LUNCH, 'reply')
    expect(await workspace.run.bodies('POST', POST)).toEqual([
      { channel: 'C1', thread_ts: LUNCH, text: 'reply' },
    ])
    expect(out).toMatchObject({ ok: true, message: { thread_ts: LUNCH } })
  })
})

describe('uploadFile', () => {
  it('asks for an upload URL, sends the bytes, then completes into the channel', async () => {
    const data = new TextEncoder().encode('RIFF')
    const out = (await uploadFile(
      workspace.accessor(),
      'C1',
      'reply.wav',
      data,
      'here',
      LUNCH,
    )) as {
      ok: boolean
      files: { id: string; title: string }[]
    }
    const [shared] = out.files
    expect([out.ok, shared?.title]).toEqual([true, 'reply.wav'])
    expect(await workspace.run.params('GET', UPLOAD_URL)).toEqual([
      { filename: 'reply.wav', length: '4' },
    ])
    expect(await workspace.run.bodies('POST', COMPLETE)).toEqual([
      {
        files: [{ id: shared?.id, title: 'reply.wav' }],
        channel_id: 'C1',
        initial_comment: 'here',
        thread_ts: LUNCH,
      },
    ])
    // The bytes sent to the upload URL are the file's.
    expect(await workspace.run.read(`/files/download/${shared?.id ?? ''}`)).toEqual(data)
  })
})
