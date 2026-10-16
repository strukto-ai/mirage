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

import type { Prisma } from '../../generated/airtable/index.js'
import { tenantWhere } from '../kit/typescript/index.ts'
import { config } from './config.ts'
import type { C } from './config.ts'
import type { JsonObject } from './wire.ts'

const KIND = config.tenantKind

export function hooksOf(db: C, tenant: string, baseId: string) {
  return db.airtableWebhook.findMany({
    where: { ...tenantWhere<Prisma.AirtableWebhookWhereInput>(tenant, KIND), baseId },
    orderBy: { seq: 'asc' },
  })
}

export async function payloadCount(db: C, tenant: string, webhookId: string): Promise<number> {
  return db.airtableWebhookPayload.count({
    where: { ...tenantWhere<Prisma.AirtableWebhookPayloadWhereInput>(tenant, KIND), webhookId },
  })
}

// What one write did to each table: its record changes in the shape a payload
// carries them, keyed by table id.
export type TableChanges = Record<string, JsonObject>

// Append one payload per webhook on the base for a write that changed records,
// numbered after the base's last write.
export async function notePayloads(
  db: C,
  tenant: string,
  baseId: string,
  stamp: string,
  changes: TableChanges,
): Promise<void> {
  if (Object.keys(changes).length === 0) return
  const hooks = await hooksOf(db, tenant, baseId)
  if (hooks.length === 0) return
  const last = await db.airtableWebhookPayload.aggregate({
    where: {
      ...tenantWhere<Prisma.AirtableWebhookPayloadWhereInput>(tenant, KIND),
      webhookId: { in: hooks.map((h) => h.id) },
    },
    _max: { transaction: true },
  })
  const transaction = (last._max.transaction ?? 0) + 1
  const body = JSON.stringify({
    timestamp: stamp,
    baseTransactionNumber: transaction,
    actionMetadata: { source: 'publicApi', sourceMetadata: {} },
    payloadFormat: 'v0',
    changedTablesById: changes,
  })
  for (const hook of hooks) {
    const cursor = (await payloadCount(db, tenant, hook.id)) + 1
    await db.airtableWebhookPayload.create({
      data: { tenant, webhookId: hook.id, cursor, transaction, body },
    })
  }
}
