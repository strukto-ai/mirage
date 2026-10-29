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

import type { SlackAccessor } from '../../accessor/slack.ts'
import type { SlackResponse } from './client.ts'

export async function postMessage(
  accessor: SlackAccessor,
  channelId: string,
  text: string,
): Promise<SlackResponse> {
  return accessor.transport.call('chat.postMessage', undefined, {
    channel: channelId,
    text,
  })
}

export async function replyToThread(
  accessor: SlackAccessor,
  channelId: string,
  threadTs: string,
  text: string,
): Promise<SlackResponse> {
  return accessor.transport.call('chat.postMessage', undefined, {
    channel: channelId,
    thread_ts: threadTs,
    text,
  })
}

/**
 * Share a file in a channel or thread, the way Slack's own SDKs do: ask for
 * an upload URL, send the bytes there, then complete the upload into the
 * conversation. The completion is a JSON body, so a long `initial_comment`
 * never outgrows a request line.
 */
export async function uploadFile(
  accessor: SlackAccessor,
  channelId: string,
  filename: string,
  data: Uint8Array,
  initialComment?: string,
  threadTs?: string,
): Promise<SlackResponse> {
  const transport = accessor.transport
  if (transport.uploadBytes === undefined) {
    throw new Error('slack transport does not support file uploads')
  }
  const ticket = await transport.call('files.getUploadURLExternal', {
    filename,
    length: String(data.byteLength),
  })
  await transport.uploadBytes(String(ticket.upload_url), data)
  const body: Record<string, unknown> = {
    files: [{ id: ticket.file_id, title: filename }],
    channel_id: channelId,
  }
  if (initialComment !== undefined && initialComment !== '') body.initial_comment = initialComment
  if (threadTs !== undefined && threadTs !== '') body.thread_ts = threadTs
  return transport.call('files.completeUploadExternal', undefined, body)
}
