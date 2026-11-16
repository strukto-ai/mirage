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

import { all, one, route } from '../kit/typescript/index.ts'
import type { Ctx, JsonValue, KitRoute, Reply } from '../kit/typescript/index.ts'
import type { C } from './config.ts'
import { documentDetail, documentSummary, recordJson } from './views.ts'
import type { DocumentRow, HitRow } from './views.ts'

const DOCS = '/datasets/:datasetId/documents'
const DOC = '/datasets/:datasetId/documents/:docId'
const SEGMENTS = '/datasets/:datasetId/documents/:docId/segments'
const RETRIEVE = '/datasets/:datasetId/retrieve'

const DOCUMENT = 'SELECT tenant, id, name, slug, size, createdAt, seq FROM DifyDocument'

function notFound(): Reply {
  return { status: 404, body: { message: 'document not found' } }
}

async function docsOf(ctx: Ctx<C>): Promise<DocumentRow[]> {
  return all<DocumentRow>(ctx.sql, `${DOCUMENT} WHERE tenant = ? ORDER BY seq`, ctx.tenant)
}

async function docById(ctx: Ctx<C>, id: string): Promise<DocumentRow | null> {
  return one<DocumentRow>(ctx.sql, `${DOCUMENT} WHERE tenant = ? AND id = ?`, ctx.tenant, id)
}

async function listDocuments(ctx: Ctx<C>): Promise<Reply> {
  const docs = await docsOf(ctx)
  return { status: 200, body: { data: docs.map(documentSummary), has_more: false } }
}

async function getDocument(ctx: Ctx<C>): Promise<Reply> {
  const doc = await docById(ctx, ctx.params.docId ?? '')
  return doc === null ? notFound() : { status: 200, body: documentDetail(doc) }
}

async function listSegments(ctx: Ctx<C>): Promise<Reply> {
  const doc = await docById(ctx, ctx.params.docId ?? '')
  if (doc === null) return notFound()
  const rows = all<{ content: string }>(
    ctx.sql,
    'SELECT content FROM DifySegment WHERE tenant = ? AND documentId = ? ORDER BY seq',
    ctx.tenant,
    doc.id,
  )
  return {
    status: 200,
    body: { data: rows.map((r) => ({ content: r.content })), has_more: false },
  }
}

// The lowest-seq rule whose keywords the query contains, which is what an
// ordered if/elif chain over substrings decided before these became rows. A
// query matching nothing answers an empty record list, not a 404.
async function retrieve(ctx: Ctx<C>): Promise<Reply> {
  const body = ctx.json()
  const asked =
    typeof body === 'object' && body !== null && !Array.isArray(body) ? body.query : null
  const query = (typeof asked === 'string' ? asked : '').toLowerCase()
  const rules = all<{ id: string; keywords: string }>(
    ctx.sql,
    'SELECT id, keywords FROM DifyRetrievalRule WHERE tenant = ? ORDER BY seq',
    ctx.tenant,
  )
  const rule = rules.find((r) => r.keywords.split(' ').some((k) => k !== '' && query.includes(k)))
  if (rule === undefined) return { status: 200, body: { records: [] } }
  const hits = all<HitRow>(
    ctx.sql,
    'SELECT pk, tenant, ruleId, documentId, content, score, seq FROM DifyRetrievalHit ' +
      'WHERE tenant = ? AND ruleId = ? ORDER BY seq',
    ctx.tenant,
    rule.id,
  )
  const records: JsonValue[] = []
  for (const hit of hits) {
    const doc = await docById(ctx, hit.documentId)
    if (doc !== null) records.push(recordJson(hit, doc))
  }
  return { status: 200, body: { records } }
}

export function difyRoutes(): KitRoute<C>[] {
  return [
    route<C>('GET', DOCS, listDocuments),
    route<C>('GET', SEGMENTS, listSegments),
    route<C>('GET', DOC, getDocument),
    route<C>('POST', RETRIEVE, retrieve),
  ]
}
