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

const ENC = new TextEncoder()

export async function searchMessages(
  accessor: SlackAccessor,
  query: string,
  count = 20,
  page = 1,
): Promise<Uint8Array> {
  const params: Record<string, string> = {
    query,
    count: String(count),
    page: String(page),
    sort: 'timestamp',
  }
  const data = await accessor.transport.call('search.messages', params)
  return ENC.encode(JSON.stringify(data))
}

export async function searchFiles(
  accessor: SlackAccessor,
  query: string,
  count = 20,
  page = 1,
): Promise<Uint8Array> {
  const params: Record<string, string> = {
    query,
    count: String(count),
    page: String(page),
    sort: 'timestamp',
  }
  const data = await accessor.transport.call('search.files', params)
  return ENC.encode(JSON.stringify(data))
}
