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

import { route } from '../kit/typescript/index.ts'
import type { Ctx, KitRoute, Reply } from '../kit/typescript/index.ts'
import { SIZELESS_IN_LISTINGS } from './config.ts'
import type { C } from './config.ts'
import {
  bytesOf,
  childrenOf,
  deleteNode,
  fileAt,
  isDir,
  makeDir,
  nameOf,
  norm,
  putFile,
} from './store.ts'
import type { NodeRow } from './store.ts'

const FILES = '/api/2.0/fs/files/*tail'
const DIRS = '/api/2.0/fs/directories/*tail'

function notFound(path: string): Reply {
  return {
    status: 404,
    body: { error_code: 'RESOURCE_DOES_NOT_EXIST', message: `Path does not exist: ${path}` },
  }
}

// RFC 7231's IMF-fixdate, which is what python's email.utils.formatdate(usegmt)
// writes. toUTCString spells it the same way, so the two fakes hand the reader
// byte-identical Last-Modified values.
function httpDate(ms: number): string {
  return new Date(ms).toUTCString()
}

function remoteOf(ctx: Ctx<C>): string {
  return `/${ctx.params.tail ?? ''}`
}

// `bytes=<start>-<end>`, with an open end meaning "to EOF" and an end past EOF
// clamped rather than refused, which is what the python fake did.
function parseRange(value: string, size: number): [number, number] {
  const spec = value.split('=')[1] ?? ''
  const cut = spec.indexOf('-')
  const startText = cut < 0 ? spec : spec.slice(0, cut)
  const endText = cut < 0 ? '' : spec.slice(cut + 1)
  const start = Number.parseInt(startText, 10)
  const end = endText === '' ? size - 1 : Number.parseInt(endText, 10)
  return [start, Math.min(end, size - 1)]
}

function headerOf(ctx: Ctx<C>, name: string): string | undefined {
  const raw = ctx.headers[name]
  const one = Array.isArray(raw) ? raw[0] : raw
  return one === undefined || one === '' ? undefined : one
}

async function readFile(ctx: Ctx<C>): Promise<Reply> {
  const remote = remoteOf(ctx)
  const row = await fileAt(ctx.sql, ctx.tenant, norm(remote))
  if (row === null) return notFound(remote)
  const data = bytesOf(row)
  const headers: Record<string, string> = { 'Last-Modified': httpDate(row.lastModified) }
  const range = headerOf(ctx, 'range')
  if (range === undefined) return { status: 200, body: data, headers }
  const [start, end] = parseRange(range, data.length)
  headers['Content-Range'] = `bytes ${String(start)}-${String(end)}/${String(data.length)}`
  return { status: 206, body: data.subarray(start, end + 1), headers }
}

// HEAD is registered rather than left to the router's GET fallback, because a
// GET is the one that honours Range: the python fake answered a HEAD 200 with
// the whole length whatever the caller asked for, and falling through would
// have answered 206 instead. The kit suppresses the body and keeps the length.
async function headFile(ctx: Ctx<C>): Promise<Reply> {
  const remote = remoteOf(ctx)
  const row = await fileAt(ctx.sql, ctx.tenant, norm(remote))
  if (row === null) return notFound(remote)
  return {
    status: 200,
    body: bytesOf(row),
    headers: { 'Last-Modified': httpDate(row.lastModified) },
  }
}

async function writeFile(ctx: Ctx<C>): Promise<Reply> {
  const remote = remoteOf(ctx)
  await putFile(ctx.sql, ctx.tenant, remote, ctx.body, ctx.clock.nowMs())
  return { status: 200, body: { path: norm(remote) } }
}

async function removeFile(ctx: Ctx<C>): Promise<Reply> {
  const remote = remoteOf(ctx)
  if ((await fileAt(ctx.sql, ctx.tenant, norm(remote))) === null) return notFound(remote)
  await deleteNode(ctx.sql, ctx.tenant, remote)
  return { status: 200, body: {} }
}

function entryJson(row: NodeRow): Record<string, string | number | boolean> {
  const name = nameOf(row.path)
  if (row.isDirectory) {
    return { path: row.path, name, is_directory: true, last_modified: row.lastModified }
  }
  const size = bytesOf(row).length
  const entry: Record<string, string | number | boolean> = {
    path: row.path,
    name,
    is_directory: false,
    file_size: size,
    last_modified: Math.trunc(row.lastModified),
  }
  if (SIZELESS_IN_LISTINGS.has(name)) delete entry.file_size
  return entry
}

async function listDir(ctx: Ctx<C>): Promise<Reply> {
  const remote = remoteOf(ctx)
  if (!(await isDir(ctx.sql, ctx.tenant, norm(remote)))) return notFound(remote)
  const rows = await childrenOf(ctx.sql, ctx.tenant, remote)
  return { status: 200, body: { contents: rows.map(entryJson), next_page_token: '' } }
}

async function headDir(ctx: Ctx<C>): Promise<Reply> {
  const remote = remoteOf(ctx)
  if (!(await isDir(ctx.sql, ctx.tenant, norm(remote)))) return notFound(remote)
  return { status: 200 }
}

async function createDir(ctx: Ctx<C>): Promise<Reply> {
  const remote = remoteOf(ctx)
  await makeDir(ctx.sql, ctx.tenant, remote)
  return { status: 200, body: { path: norm(remote) } }
}

// The Files API deletes only an empty directory: a caller removes what is in
// it first, and a child written after its listing refuses the delete. The
// refusal is the generic one, not a probed wording.
async function removeDir(ctx: Ctx<C>): Promise<Reply> {
  const remote = remoteOf(ctx)
  if (!(await isDir(ctx.sql, ctx.tenant, norm(remote)))) return notFound(remote)
  if ((await childrenOf(ctx.sql, ctx.tenant, remote)).length > 0) {
    return {
      status: 400,
      body: { error_code: 'BAD_REQUEST', message: `Directory is not empty: ${remote}` },
    }
  }
  await deleteNode(ctx.sql, ctx.tenant, remote)
  return { status: 200, body: {} }
}

export function databricksRoutes(): KitRoute<C>[] {
  return [
    route<C>('HEAD', FILES, headFile),
    route<C>('GET', FILES, readFile),
    route<C>('PUT', FILES, writeFile, { write: true }),
    route<C>('DELETE', FILES, removeFile, { write: true }),
    route<C>('HEAD', DIRS, headDir),
    route<C>('GET', DIRS, listDir),
    route<C>('PUT', DIRS, createDir, { write: true }),
    route<C>('DELETE', DIRS, removeDir, { write: true }),
  ]
}
