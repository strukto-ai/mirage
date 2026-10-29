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
import { SlackAccessor } from '../../accessor/slack.ts'
import type { SlackResponse, SlackTransport } from './client.ts'
import { postMessage, replyToThread, uploadFile } from './post.ts'

class FakeTransport implements SlackTransport {
  public readonly calls: { endpoint: string; params?: Record<string, string>; body?: unknown }[] =
    []
  constructor(private readonly responder: () => SlackResponse = () => ({ ok: true })) {}
  call(endpoint: string, params?: Record<string, string>, body?: unknown): Promise<SlackResponse> {
    this.calls.push({
      endpoint,
      ...(params !== undefined ? { params } : {}),
      ...(body !== undefined ? { body } : {}),
    })
    return Promise.resolve(this.responder())
  }
}

describe('postMessage', () => {
  it('POSTs to chat.postMessage with channel and text', async () => {
    const t = new FakeTransport(() => ({ ok: true, ts: '1.2' }))
    const out = await postMessage(new SlackAccessor(t), 'C1', 'hello')
    expect(t.calls[0]?.endpoint).toBe('chat.postMessage')
    expect(t.calls[0]?.params).toBeUndefined()
    expect(t.calls[0]?.body).toEqual({ channel: 'C1', text: 'hello' })
    expect(out).toMatchObject({ ok: true, ts: '1.2' })
  })
})

describe('replyToThread', () => {
  it('POSTs with thread_ts to chat.postMessage', async () => {
    const t = new FakeTransport(() => ({ ok: true, ts: '3.4' }))
    const out = await replyToThread(new SlackAccessor(t), 'C1', '1.2', 'reply')
    expect(t.calls[0]?.endpoint).toBe('chat.postMessage')
    expect(t.calls[0]?.body).toEqual({ channel: 'C1', thread_ts: '1.2', text: 'reply' })
    expect(out).toMatchObject({ ok: true, ts: '3.4' })
  })
})

describe('uploadFile', () => {
  it('asks for an upload URL, sends the bytes, then completes into the channel', async () => {
    const answers: SlackResponse[] = [
      { ok: true, upload_url: 'https://files.example/u/1', file_id: 'F1' },
      { ok: true, files: [{ id: 'F1', title: 'reply.wav' }] },
    ]
    const sent: [string, Uint8Array][] = []
    class Uploading extends FakeTransport {
      uploadBytes(url: string, data: Uint8Array): Promise<void> {
        sent.push([url, data])
        return Promise.resolve()
      }
    }
    const t = new Uploading(() => answers.shift() ?? { ok: true })
    const data = new TextEncoder().encode('RIFF')
    const out = await uploadFile(new SlackAccessor(t), 'C1', 'reply.wav', data, 'here', '9.9')
    expect(t.calls).toEqual([
      { endpoint: 'files.getUploadURLExternal', params: { filename: 'reply.wav', length: '4' } },
      {
        endpoint: 'files.completeUploadExternal',
        params: {
          files: '[{"id":"F1","title":"reply.wav"}]',
          channel_id: 'C1',
          initial_comment: 'here',
          thread_ts: '9.9',
        },
      },
    ])
    expect(sent).toEqual([['https://files.example/u/1', data]])
    expect(out).toMatchObject({ ok: true, files: [{ id: 'F1' }] })
  })
})
