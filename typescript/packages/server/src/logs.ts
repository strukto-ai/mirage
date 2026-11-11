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

import { Buffer } from 'node:buffer'
import { yieldBytes } from '@struktoai/mirage-core/io/stream'
import { z } from '@struktoai/mirage-core/vfs/secrets'
import type { JsonObject } from '@struktoai/mirage-core/types'
import { msToRfc3339 } from '@struktoai/mirage-core/utils/dates'
import { checkName } from '@struktoai/mirage-core/utils/ids'

const common = z.object({ session: z.string(), timestamp: z.number(), cwd: z.string().optional() })
const commandRecord = common.extend({
  type: z.literal('command'),
  id: z.string(),
  command: z.string(),
})
const resultRecord = common.extend({
  type: z.literal('result'),
  parent: z.string(),
  duration_ms: z.number().default(0),
  exit_code: z.number().nullable().default(null),
  stdout: z.string().default(''),
  stderr: z.string().default(''),
})
const mountRecord = common.extend({
  type: z.literal('vfs'),
  parent: z.string(),
  vfs: z.string(),
  path: z.string(),
  source: z.string().default(''),
  bytes: z.number().nullable().default(null),
  duration_ms: z.number().default(0),
})
const cursorValue = z.tuple([z.number().int().nonnegative(), z.string().min(1)])

export function sessionFilter(session: string | undefined): string | undefined {
  if (session === '' || session === undefined) return undefined
  checkName('session id', session)
  return session
}

export function logAttachment(workspaceId: string): string {
  const filename = encodeURIComponent(`${workspaceId}-logs.jsonl`).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `attachment; filename="logs.jsonl"; filename*=UTF-8''${filename}`
}

export function completedLogs(records: JsonObject[]) {
  const commands = records
    .filter((e) => e.type === 'command' && typeof e.id === 'string')
    .map((e) => commandRecord.parse(e))
  const results = new Map(
    records
      .filter((e) => e.type === 'result' && typeof e.parent === 'string')
      .map((e) => {
        const result = resultRecord.parse(e)
        return [result.parent, result]
      }),
  )
  const calls = new Map<string, z.infer<typeof mountRecord>[]>()
  for (const event of records) {
    if (event.type !== 'vfs' || typeof event.parent !== 'string') continue
    const call = mountRecord.parse(event)
    const group = calls.get(call.parent) ?? []
    group.push(call)
    calls.set(call.parent, group)
  }
  return commands
    .flatMap((command) => {
      const result = results.get(command.id)
      if (result === undefined) return []
      const mounts = (calls.get(command.id) ?? []).sort(
        (a, b) => a.timestamp - a.duration_ms - (b.timestamp - b.duration_ms),
      )
      return [
        {
          timestamp: command.timestamp,
          records: [command, ...mounts, result],
          item: {
            id: command.id,
            command: command.command,
            cwd: command.cwd ?? null,
            started_at: msToRfc3339(command.timestamp),
            duration_ms: result.duration_ms,
            exit_code: result.exit_code,
            stdout: result.stdout,
            stderr: result.stderr,
            user_id: null,
            api_key_id: null,
            mounts: mounts.map((e) => ({
              op: e.vfs,
              path: e.path,
              source: e.source,
              bytes: e.bytes,
              started_at: msToRfc3339(e.timestamp - e.duration_ms),
              duration_ms: e.duration_ms,
            })),
          },
        },
      ]
    })
    .sort(
      (a, b) =>
        b.timestamp - a.timestamp || (a.item.id < b.item.id ? 1 : a.item.id > b.item.id ? -1 : 0),
    )
}

type LoggedCommand = ReturnType<typeof completedLogs>[number]

export function logPage(logs: LoggedCommand[], limit = '50', after?: string) {
  const count = Number(limit)
  if (!Number.isInteger(count) || count < 1 || count > 200) throw new Error('limit must be 1-200')
  if (after !== undefined && after !== '') {
    let key: z.infer<typeof cursorValue>
    try {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(after))
        throw new Error()
      key = cursorValue.parse(JSON.parse(Buffer.from(after, 'base64').toString('utf8')))
    } catch {
      throw new Error('after is not a cursor')
    }
    logs = logs.filter(
      (log) => log.timestamp < key[0] || (log.timestamp === key[0] && log.item.id < key[1]),
    )
  }
  const picked = logs.slice(0, count)
  const last = picked.at(-1)
  return {
    items: picked.map((log) => log.item),
    next:
      logs.length > count && last !== undefined
        ? Buffer.from(JSON.stringify([last.timestamp, last.item.id])).toString('base64')
        : null,
  }
}

export async function* logLines(logs: LoggedCommand[]) {
  const encoder = new TextEncoder()
  for (const log of [...logs].reverse()) {
    for (const record of log.records) {
      const shown = { ...record, timestamp: msToRfc3339(record.timestamp) }
      yield* yieldBytes(encoder.encode(`${JSON.stringify(shown)}\n`))
    }
  }
}
