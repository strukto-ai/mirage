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

import type { DatabaseSync } from 'node:sqlite'
import { BYTES, all, bytes, exec, one, stmt } from '../kit/typescript/index.ts'

export interface NodeRow {
  path: string
  isDirectory: boolean
  // SQLite reads a BLOB back as a Uint8Array, not a Buffer, and the kit only
  // recognizes a Buffer as a raw body: typing this as Buffer made every file
  // read answer a JSON object of byte values. `bytesOf` is the one place that
  // conversion happens.
  data: Uint8Array | null
  lastModified: number
  seq: number
}

export function bytesOf(row: NodeRow): Buffer {
  return row.data === null ? Buffer.alloc(0) : Buffer.from(row.data)
}

// posixpath.normpath("/" + path.strip("/")), which collapses "//" and resolves
// "." and ".." without touching a filesystem. Written out because node's
// path.posix.normalize keeps a trailing slash and answers "." for the empty
// string, and a path that normalizes differently in the two fakes is a
// divergence no golden would explain.
export function norm(path: string): string {
  const parts = path.split('/').filter((p) => p !== '' && p !== '.')
  const out: string[] = []
  for (const part of parts) {
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`.replace(/\/$/, '') || '/'
}

export function parentOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut <= 0 ? '/' : path.slice(0, cut)
}

export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

// The run's file over node:sqlite (kit sql.ts), on the table
// prisma/databricks.prisma declares.
type Db = DatabaseSync

const NODE = 'SELECT path, isDirectory, data, lastModified, seq FROM DatabricksNode'

// The seq a new row takes: one past the tenant's highest, 0 for the first.
const NEXT_SEQ = '(SELECT COALESCE(MAX(seq) + 1, 0) FROM DatabricksNode WHERE tenant = ?)'

interface Row extends Omit<NodeRow, 'isDirectory'> {
  isDirectory: number
}

function toNode(row: Row): NodeRow {
  return { ...row, isDirectory: row.isDirectory === 1 }
}

export async function nodeAt(db: Db, tenant: string, path: string): Promise<NodeRow | null> {
  const row = one<Row>(db, `${NODE} WHERE tenant = ? AND path = ?`, tenant, path)
  return row === null ? null : toNode(row)
}

export async function fileAt(db: Db, tenant: string, path: string): Promise<NodeRow | null> {
  const row = await nodeAt(db, tenant, path)
  return row === null || row.isDirectory ? null : row
}

export async function isDir(db: Db, tenant: string, path: string): Promise<boolean> {
  const row = await nodeAt(db, tenant, path)
  return row !== null && row.isDirectory
}

// Every ancestor of a written path becomes a directory, which is what the
// python store's _add_ancestors did on both put_file and make_dir. A databricks
// volume has no mkdir -p, so a file written three levels down has to leave the
// two directories above it listable.
export async function addAncestors(db: Db, tenant: string, path: string): Promise<void> {
  let current = parentOf(path)
  for (;;) {
    exec(
      db,
      'INSERT INTO DatabricksNode (tenant, path, isDirectory, data, lastModified, seq) ' +
        `VALUES (?, ?, 1, NULL, 0, ${NEXT_SEQ}) ` +
        'ON CONFLICT (tenant, path) DO UPDATE SET isDirectory = 1, data = NULL',
      tenant,
      current,
      tenant,
    )
    if (current === '/') return
    current = parentOf(current)
  }
}

export async function putFile(
  db: Db,
  tenant: string,
  path: string,
  data: Buffer,
  mtimeMs: number,
): Promise<void> {
  const at = norm(path)
  exec(
    db,
    'INSERT INTO DatabricksNode (tenant, path, isDirectory, data, lastModified, seq) ' +
      `VALUES (?, ?, 0, ${BYTES}, ?, ${NEXT_SEQ}) ON CONFLICT (tenant, path) DO UPDATE SET ` +
      'isDirectory = 0, data = excluded.data, lastModified = excluded.lastModified',
    tenant,
    at,
    ...bytes(data),
    mtimeMs,
    tenant,
  )
  await addAncestors(db, tenant, at)
}

export async function makeDir(db: Db, tenant: string, path: string): Promise<void> {
  const at = norm(path)
  exec(
    db,
    'INSERT INTO DatabricksNode (tenant, path, isDirectory, data, lastModified, seq) ' +
      `VALUES (?, ?, 1, NULL, 0, ${NEXT_SEQ}) ON CONFLICT (tenant, path) DO NOTHING`,
    tenant,
    at,
    tenant,
  )
  await addAncestors(db, tenant, at)
}

// Throws on a missing row, as Prisma's delete did; every route checks first.
function deleteOne(db: Db, tenant: string, path: string): void {
  const done = stmt(db, 'DELETE FROM DatabricksNode WHERE tenant = ? AND path = ?').run(
    tenant,
    path,
  )
  if (done.changes === 0) throw new Error(`databricks fake: ${path} is already gone`)
}

export async function deleteNode(db: Db, tenant: string, path: string): Promise<void> {
  deleteOne(db, tenant, norm(path))
}

// Children of one directory, files before directories and each in insertion
// order, which is the order the two python dicts iterated in. Only rows under
// the directory's own prefix are read; `parentOf` still decides.
export async function childrenOf(db: Db, tenant: string, path: string): Promise<NodeRow[]> {
  const at = norm(path)
  const rows =
    at === '/'
      ? all<Row>(db, `${NODE} WHERE tenant = ? ORDER BY seq`, tenant)
      : all<Row>(
          db,
          `${NODE} WHERE tenant = ? AND substr(path, 1, length(?)) = ? ORDER BY seq`,
          tenant,
          `${at}/`,
          `${at}/`,
        )
  const kids = rows.map(toNode).filter((r) => r.path !== '/' && parentOf(r.path) === at)
  return [...kids.filter((r) => !r.isDirectory), ...kids.filter((r) => r.isDirectory)]
}
