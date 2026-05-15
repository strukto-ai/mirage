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
import { offsetPages } from './paginate.ts'

export interface SlackFile {
  id: string
  name?: string
  title?: string
  mimetype?: string
  filetype?: string
  size?: number
  timestamp?: number
  url_private_download?: string
  [key: string]: unknown
}

function dayRangeTs(dateStr: string): { tsFrom: string; tsTo: string } {
  const parts = dateStr.split('-').map((s) => Number.parseInt(s, 10))
  const y = parts[0]
  const m = parts[1]
  const d = parts[2]
  if (
    y === undefined ||
    m === undefined ||
    d === undefined ||
    !Number.isFinite(y) ||
    !Number.isFinite(m) ||
    !Number.isFinite(d)
  ) {
    throw new Error(`Invalid date_str: ${dateStr}`)
  }
  const start = Date.UTC(y, m - 1, d, 0, 0, 0) / 1000
  const end = Date.UTC(y, m - 1, d, 23, 59, 59) / 1000
  return { tsFrom: String(start), tsTo: String(end) }
}

export function listFilesForDayStream(
  accessor: SlackAccessor,
  channelId: string,
  dateStr: string,
  options: { count?: number; maxPages?: number } = {},
): AsyncIterableIterator<SlackFile[]> {
  const count = options.count ?? 200
  const { tsFrom, tsTo } = dayRangeTs(dateStr)
  return offsetPages<SlackFile>(
    accessor.transport,
    'files.list',
    {
      channel: channelId,
      ts_from: tsFrom,
      ts_to: tsTo,
      count: String(count),
    },
    ['paging', 'pages'],
    ['files'],
    options.maxPages !== undefined ? { maxPages: options.maxPages } : {},
  )
}

export async function listFilesForDay(
  accessor: SlackAccessor,
  channelId: string,
  dateStr: string,
  options: { count?: number } = {},
): Promise<SlackFile[]> {
  const out: SlackFile[] = []
  for await (const page of listFilesForDayStream(accessor, channelId, dateStr, options)) {
    out.push(...page)
  }
  return out
}
