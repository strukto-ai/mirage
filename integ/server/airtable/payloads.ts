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

import type { AirtableWebhook } from '../../generated/airtable/index.js'
import { all, exec, one, transaction } from '../kit/typescript/index.ts'
import type { Db } from './store.ts'
import type { JsonObject } from './wire.ts'

export const WEBHOOK =
  'SELECT tenant, id, baseId, spec, url, expirationTime, lastCursor, seq FROM AirtableWebhook'

export async function hooksOf(db: Db, tenant: string, baseId: string): Promise<AirtableWebhook[]> {
  return all<AirtableWebhook>(
    db,
    `${WEBHOOK} WHERE tenant = ? AND baseId = ? ORDER BY seq`,
    tenant,
    baseId,
  )
}

// The number of the webhook's last payload, 0 before its first; one that has
// expired leaves its number taken.
function lastCursor(db: Db, tenant: string, webhookId: string): number {
  const found = one<{ n: number }>(
    db,
    'SELECT lastCursor AS n FROM AirtableWebhook WHERE tenant = ? AND id = ?',
    tenant,
    webhookId,
  )
  return found?.n ?? 0
}

// What one write did to each table: its record changes in the shape a payload
// carries them, keyed by table id.
export type TableChanges = Record<string, JsonObject>

// Append one payload per webhook on the base for a write that changed records,
// numbered after the base's last write. The payloads and the cursors they take
// land as one transaction: a payload stored with its cursor left untaken would
// have the next write number its own payload the same, which the payload key
// refuses.
export async function notePayloads(
  db: Db,
  tenant: string,
  baseId: string,
  stamp: string,
  changes: TableChanges,
): Promise<void> {
  if (Object.keys(changes).length === 0) return
  const hooks = await hooksOf(db, tenant, baseId)
  if (hooks.length === 0) return
  transaction(db, () => {
    const last = one<{ n: number | null }>(
      db,
      'SELECT MAX("transaction") AS n FROM AirtableWebhookPayload WHERE tenant = ? AND ' +
        'webhookId IN (SELECT value FROM json_each(?))',
      tenant,
      JSON.stringify(hooks.map((h) => h.id)),
    )
    const baseTransaction = (last?.n ?? 0) + 1
    const body = JSON.stringify({
      timestamp: stamp,
      baseTransactionNumber: baseTransaction,
      actionMetadata: { source: 'publicApi', sourceMetadata: {} },
      payloadFormat: 'v0',
      changedTablesById: changes,
    })
    for (const hook of hooks) {
      const cursor = lastCursor(db, tenant, hook.id) + 1
      exec(
        db,
        'INSERT INTO AirtableWebhookPayload (tenant, webhookId, cursor, "transaction", body) ' +
          'VALUES (?, ?, ?, ?, ?)',
        tenant,
        hook.id,
        cursor,
        baseTransaction,
        body,
      )
      exec(
        db,
        'UPDATE AirtableWebhook SET lastCursor = ? WHERE tenant = ? AND id = ?',
        cursor,
        tenant,
        hook.id,
      )
    }
  })
}
