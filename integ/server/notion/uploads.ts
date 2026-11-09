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

import { readMultipart } from '../box/multipart.ts'
import type { Ctx, JsonValue, Reply } from '../kit/typescript/index.ts'
import type { C } from './config.ts'
import { apiError, mintId, notFound } from './wire.ts'

const UPLOAD_ID_PREFIX = '77777777'
const EXPIRY_MS = 60 * 60 * 1000

interface UploadRow {
  id: string
  mode: string
  status: string
  filename: string
  contentType: string | null
  contentLength: number | null
  numberOfParts: number | null
  partsJson: string
  createdTime: string
  expiryTime: string
}

function render(ctx: Ctx<C>, row: UploadRow): JsonValue {
  const pending = row.status === 'pending'
  const base = `${ctx.url.origin}/v1/file_uploads/${row.id}`
  return {
    object: 'file_upload',
    id: row.id,
    created_time: row.createdTime,
    last_edited_time: row.createdTime,
    expiry_time: row.expiryTime,
    upload_url: pending && row.mode !== 'external_url' ? `${base}/send` : null,
    complete_url: pending && row.mode === 'multi_part' ? `${base}/complete` : null,
    archived: false,
    status: row.status,
    filename: row.filename,
    content_type: row.contentType,
    content_length: row.contentLength,
  }
}

function asText(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function receivedParts(row: UploadRow): Set<number> {
  return new Set(JSON.parse(row.partsJson) as number[])
}

async function found(ctx: Ctx<C>): Promise<UploadRow | null> {
  return ctx.db.notionFileUpload.findUnique({
    where: { tenant_id: { tenant: ctx.tenant, id: ctx.params.id ?? '' } },
  })
}

export async function createUpload(ctx: Ctx<C>): Promise<Reply> {
  const body = ctx.json() as { [key: string]: JsonValue }
  const mode = asText(body.mode) ?? 'single_part'
  const filename = asText(body.filename)
  if (mode === 'multi_part' && (filename === null || typeof body.number_of_parts !== 'number')) {
    return apiError(400, 'validation_error', 'filename and number_of_parts are required.')
  }
  if (mode === 'external_url' && asText(body.external_url) === null) {
    return apiError(400, 'validation_error', 'external_url should be defined.')
  }
  const now = ctx.clock.nowMs()
  const seq = await ctx.db.notionFileUpload.count({ where: { tenant: ctx.tenant } })
  const row = await ctx.db.notionFileUpload.create({
    data: {
      tenant: ctx.tenant,
      id: mintId(ctx.minter, UPLOAD_ID_PREFIX),
      seq,
      mode,
      status: mode === 'external_url' ? 'uploaded' : 'pending',
      filename: filename ?? 'upload.bin',
      contentType: asText(body.content_type),
      numberOfParts: mode === 'multi_part' ? (body.number_of_parts as number) : null,
      createdTime: new Date(now).toISOString(),
      expiryTime: new Date(now + EXPIRY_MS).toISOString(),
    },
  })
  return { status: 200, body: render(ctx, row) }
}

export async function sendUpload(ctx: Ctx<C>): Promise<Reply> {
  const row = await found(ctx)
  if (row === null) return notFound('file upload', ctx.params.id ?? '')
  if (row.status !== 'pending') {
    return apiError(400, 'validation_error', 'This file upload is not pending.')
  }
  const form = await readMultipart(ctx)
  const file = form.file
  if (file === undefined) return apiError(400, 'validation_error', 'file should be defined.')
  const parts = receivedParts(row)
  if (row.mode === 'multi_part') {
    const number = Number(form.part_number?.text)
    if (!Number.isInteger(number) || number < 1 || number > (row.numberOfParts ?? 0)) {
      return apiError(400, 'validation_error', 'part_number is out of range.')
    }
    parts.add(number)
  }
  const updated = await ctx.db.notionFileUpload.update({
    where: { tenant_id: { tenant: ctx.tenant, id: row.id } },
    data: {
      contentLength: (row.contentLength ?? 0) + file.bytes.byteLength,
      partsJson: JSON.stringify([...parts]),
      status: row.mode === 'multi_part' ? 'pending' : 'uploaded',
    },
  })
  return { status: 200, body: render(ctx, updated) }
}

export async function completeUpload(ctx: Ctx<C>): Promise<Reply> {
  const row = await found(ctx)
  if (row === null) return notFound('file upload', ctx.params.id ?? '')
  if (row.mode !== 'multi_part' || row.status !== 'pending') {
    return apiError(400, 'validation_error', 'This file upload cannot be completed.')
  }
  const received = receivedParts(row).size
  if (received !== row.numberOfParts) {
    return apiError(
      400,
      'validation_error',
      `Expected ${String(row.numberOfParts)} parts, received ${String(received)}.`,
    )
  }
  const updated = await ctx.db.notionFileUpload.update({
    where: { tenant_id: { tenant: ctx.tenant, id: row.id } },
    data: { status: 'uploaded' },
  })
  return { status: 200, body: render(ctx, updated) }
}

export async function getUpload(ctx: Ctx<C>): Promise<Reply> {
  const row = await found(ctx)
  if (row === null) return notFound('file upload', ctx.params.id ?? '')
  return { status: 200, body: render(ctx, row) }
}

export async function listUploads(ctx: Ctx<C>): Promise<Reply> {
  const rows = await ctx.db.notionFileUpload.findMany({
    where: { tenant: ctx.tenant },
    orderBy: { seq: 'desc' },
  })
  return {
    status: 200,
    body: {
      object: 'list',
      results: rows.map((row) => render(ctx, row)),
      next_cursor: null,
      has_more: false,
      type: 'file_upload',
      file_upload: {},
    },
  }
}
