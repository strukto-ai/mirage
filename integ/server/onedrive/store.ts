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
import { BYTES, all, bytes, exec, one } from '../kit/typescript/index.ts'
import type { Clock, JsonValue, Minter } from '../kit/typescript/index.ts'
import { DEFAULT_DRIVE, ENRICH_MARKER, OFFICE_EXTENSIONS } from './config.ts'
import { baseName, dirName, joinPath, norm } from './paths.ts'

// The run's file over node:sqlite (kit sql.ts). The tables are the ones
// prisma/onedrive.prisma declares: a model is a table of its name and a field
// a column of its name, Bytes a BLOB and Int an INTEGER.
export type Db = DatabaseSync

export interface FileRow {
  drive: string
  path: string
  content: Uint8Array
  size: number
  ctag: string
  etag: string
  modified: string
  seq: number
}

export interface VersionRow {
  drive: string
  path: string
  versionId: string
  modified: string
  content: Uint8Array
  seq: number
}

export interface UploadRow {
  token: string
  drive: string
  path: string
  buffer: Uint8Array
  behavior: string
  seq: number
}

export interface Ctx0 {
  db: Db
  tenant: string
  clock: Clock
  minter: Minter
}

const FILE = 'SELECT drive, path, content, size, ctag, etag, modified, seq FROM GraphFile'
const VERSION = 'SELECT drive, path, versionId, modified, content, seq FROM GraphVersion'

// `startsWith` as Prisma ran it on SQLite, which every prefix query here
// used to be: LIKE with the prefix unescaped, so ASCII case is ignored and a
// `%` or `_` in a path matches as a wildcard. Kept exactly, so this module
// answers what it answered on Prisma.
function like(prefix: string): string {
  return `${prefix}%`
}

export async function drives(db: Db, tenant: string): Promise<string[]> {
  const rows = all<{ key: string }>(
    db,
    'SELECT key FROM GraphDrive WHERE tenant = ? ORDER BY seq',
    tenant,
  )
  return rows.map((r) => r.key)
}

// A drive named on a URL that no fixture declared is not an error the caller
// can act on: the vendor would 404 the drive itself. The default drive always
// exists, because /me/drive has to resolve before anything has been declared.
export async function hasDrive(db: Db, tenant: string, key: string): Promise<boolean> {
  if (key === DEFAULT_DRIVE) return true
  return one(db, 'SELECT 1 FROM GraphDrive WHERE tenant = ? AND key = ?', tenant, key) !== null
}

// The provisioning write behind `PUT /drives/:key`. Idempotent, so an adapter
// that declares the same drive once per mount does not have to check first.
export async function addDrive(ctx: Ctx0, key: string): Promise<void> {
  if (one(ctx.db, 'SELECT 1 FROM GraphDrive WHERE tenant = ? AND key = ?', ctx.tenant, key)) {
    return
  }
  exec(
    ctx.db,
    'INSERT INTO GraphDrive (tenant, key, isDefault, seq) VALUES (?, ?, ?, ?)',
    ctx.tenant,
    key,
    key === DEFAULT_DRIVE ? 1 : 0,
    ctx.minter.next('drive'),
  )
}

export async function fileAt(
  db: Db,
  tenant: string,
  drive: string,
  path: string,
): Promise<FileRow | null> {
  return one<FileRow>(
    db,
    `${FILE} WHERE tenant = ? AND drive = ? AND path = ?`,
    tenant,
    drive,
    norm(path),
  )
}

export async function dirAt(db: Db, tenant: string, drive: string, path: string): Promise<boolean> {
  const p = norm(path)
  if (p === '') return true
  return (
    one(
      db,
      'SELECT 1 FROM GraphDir WHERE tenant = ? AND drive = ? AND path = ?',
      tenant,
      drive,
      p,
    ) !== null
  )
}

/** A folder's own times, ISO 8601 to the second. */
export interface DirStamps {
  created: string
  modified: string
}

/**
 * The times a folder row holds, or null when no folder is at `path`. The
 * drive root has no row: it is older than anything in the run, so the caller
 * names its times.
 */
export async function dirStamps(
  db: Db,
  tenant: string,
  drive: string,
  path: string,
): Promise<DirStamps | null> {
  return one<DirStamps>(
    db,
    'SELECT created, modified FROM GraphDir WHERE tenant = ? AND drive = ? AND path = ?',
    tenant,
    drive,
    norm(path),
  )
}

function madeNow(ctx: Ctx0): DirStamps {
  const now = ctx.clock.nowIso(false)
  return { created: now, modified: now }
}

// A new folder is made now; a moved one brings the times it had.
function insertDir(ctx: Ctx0, drive: string, path: string, stamps: DirStamps = madeNow(ctx)): void {
  exec(
    ctx.db,
    'INSERT INTO GraphDir (tenant, drive, path, created, modified, seq) VALUES (?, ?, ?, ?, ?, ?)',
    ctx.tenant,
    drive,
    path,
    stamps.created,
    stamps.modified,
    ctx.minter.next('dir'),
  )
}

export async function ensureParents(ctx: Ctx0, drive: string, path: string): Promise<void> {
  let parent = dirName(norm(path))
  const missing: string[] = []
  while (parent !== '') {
    missing.push(parent)
    parent = dirName(parent)
  }
  for (const dir of missing.reverse()) {
    if (!(await dirAt(ctx.db, ctx.tenant, drive, dir))) {
      insertDir(ctx, drive, dir)
      await noteChange(ctx, drive, folderId(drive, dir), dir)
    }
  }
}

export async function addDir(ctx: Ctx0, drive: string, path: string): Promise<void> {
  await ensureParents(ctx, drive, path)
  const p = norm(path)
  if (p === '') return
  if (await dirAt(ctx.db, ctx.tenant, drive, p)) return
  insertDir(ctx, drive, p)
  await noteChange(ctx, drive, folderId(drive, p), p)
}

// A file keeps the seq it was created with through every write and move, as
// a vendor id survives both; a folder is named by its path.
export function fileId(drive: string, seq: number): string {
  return `${drive}:file:${String(seq)}`
}

export function folderId(drive: string, path: string): string {
  const p = norm(path)
  return p === '' ? `${drive}:root` : `${drive}:folder:${p}`
}

/** The file whose id is `id`, or null. */
export async function fileById(
  db: Db,
  tenant: string,
  drive: string,
  id: string,
): Promise<FileRow | null> {
  const prefix = `${drive}:file:`
  if (!id.startsWith(prefix)) return null
  const seq = Number(id.slice(prefix.length))
  if (!Number.isInteger(seq)) return null
  return one<FileRow>(db, `${FILE} WHERE tenant = ? AND drive = ? AND seq = ?`, tenant, drive, seq)
}

/** Record that an item changed and where it now is, for the next /delta read. */
export async function noteChange(
  ctx: Ctx0,
  drive: string,
  itemId: string,
  path: string,
): Promise<void> {
  exec(
    ctx.db,
    'INSERT INTO GraphChange (tenant, drive, itemId, path, seq) VALUES (?, ?, ?, ?, ?)',
    ctx.tenant,
    drive,
    itemId,
    norm(path),
    ctx.minter.next('change'),
  )
}

/** Each change after `after`, oldest first. */
export async function changesAfter(
  db: Db,
  tenant: string,
  drive: string,
  after: number,
): Promise<{ itemId: string; path: string }[]> {
  return all(
    db,
    'SELECT itemId, path FROM GraphChange WHERE tenant = ? AND drive = ? AND seq > ? ORDER BY seq',
    tenant,
    drive,
    after,
  )
}

/** The seq of the newest change, 0 when the drive has none. */
export async function lastChange(db: Db, tenant: string, drive: string): Promise<number> {
  const row = one<{ seq: number }>(
    db,
    'SELECT seq FROM GraphChange WHERE tenant = ? AND drive = ? ORDER BY seq DESC LIMIT 1',
    tenant,
    drive,
  )
  return row?.seq ?? 0
}

function enriched(path: string, content: Uint8Array): Uint8Array {
  const lower = path.toLowerCase()
  if (!OFFICE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return content
  const marker = new TextEncoder().encode(ENRICH_MARKER)
  const tail = content.slice(Math.max(0, content.length - marker.length))
  // Only uploads enrich, and the rewrite is idempotent rather than
  // accumulative, exactly like real SharePoint: a server-side copy of an
  // already enriched file must not gain a second marker.
  if (tail.length === marker.length && tail.every((b, i) => b === marker[i])) return content
  const out = new Uint8Array(content.length + marker.length)
  out.set(content, 0)
  out.set(marker, content.length)
  return out
}

function insertFile(ctx: Ctx0, row: FileRow): void {
  exec(
    ctx.db,
    'INSERT INTO GraphFile (tenant, drive, path, content, size, ctag, etag, modified, seq) ' +
      `VALUES (?, ?, ?, ${BYTES}, ?, ?, ?, ?, ?)`,
    ctx.tenant,
    row.drive,
    row.path,
    ...bytes(row.content),
    row.size,
    row.ctag,
    row.etag,
    row.modified,
    row.seq,
  )
}

function insertVersion(ctx: Ctx0, row: VersionRow): void {
  exec(
    ctx.db,
    'INSERT INTO GraphVersion (tenant, drive, path, versionId, modified, content, seq) ' +
      `VALUES (?, ?, ?, ?, ?, ${BYTES}, ?)`,
    ctx.tenant,
    row.drive,
    row.path,
    row.versionId,
    row.modified,
    ...bytes(row.content),
    row.seq,
  )
}

/**
 * Write a file, keeping the prior content as a version.
 *
 * Args:
 *   ctx (Ctx0): db, tenant, clock and minter for this request.
 *   drive (string): which drive to write into.
 *   path (string): the item path inside that drive.
 *   content (Uint8Array): the bytes to store.
 *   enrich (boolean): whether this write is an UPLOAD, which is the only
 *     thing that triggers the Office metadata rewrite.
 */
export async function writeFile(
  ctx: Ctx0,
  drive: string,
  path: string,
  content: Uint8Array,
  enrich = false,
): Promise<FileRow> {
  const p = norm(path)
  // Real Graph auto-creates missing parent folders for some path-addressed
  // uploads and 404s for others (shared/remote folders); the fake always
  // creates them (unpinned edge case).
  await ensureParents(ctx, drive, p)
  const body = enrich ? enriched(p, content) : content
  const tag = `${drive}-tag${String(ctx.minter.next('tag'))}`
  // The vendor's cTag is never its eTag's string, even right after a write
  // ("c:{id},n" beside "{id},n"), so a client that reads one for the other
  // finds them unequal here too.
  const ctag = `c:${tag}`
  const prior =
    one<{ n: number }>(
      ctx.db,
      'SELECT COUNT(*) AS n FROM GraphVersion WHERE tenant = ? AND drive = ? AND path = ?',
      ctx.tenant,
      drive,
      p,
    )?.n ?? 0
  const stamp = ctx.clock.nowIso(false)
  insertVersion(ctx, {
    drive,
    path: p,
    versionId: `${String(prior + 1)}.0`,
    modified: stamp,
    content: body,
    seq: ctx.minter.next('ver'),
  })
  // Prisma's upsert built its create branch, and so took this number, even
  // when the row existed; the counter is shared, so skipping it on a rewrite
  // would renumber every file, tag and change minted after it.
  const created = ctx.minter.next('file')
  const was = await fileAt(ctx.db, ctx.tenant, drive, p)
  let row: FileRow
  if (was === null) {
    row = {
      drive,
      path: p,
      content: body,
      size: body.length,
      ctag,
      etag: tag,
      modified: stamp,
      seq: created,
    }
    insertFile(ctx, row)
  } else {
    row = { ...was, content: body, size: body.length, ctag, etag: tag, modified: stamp }
    exec(
      ctx.db,
      `UPDATE GraphFile SET content = ${BYTES}, size = ?, ctag = ?, etag = ?, modified = ? ` +
        'WHERE tenant = ? AND drive = ? AND path = ?',
      ...bytes(body),
      body.length,
      ctag,
      tag,
      stamp,
      ctx.tenant,
      drive,
      p,
    )
  }
  await noteChange(ctx, drive, fileId(drive, row.seq), p)
  return row
}

export async function childNames(
  db: Db,
  tenant: string,
  drive: string,
  dir: string,
): Promise<string[]> {
  const d = norm(dir)
  const names = new Set<string>()
  const files = all<{ path: string }>(
    db,
    'SELECT path FROM GraphFile WHERE tenant = ? AND drive = ?',
    tenant,
    drive,
  )
  for (const f of files) {
    if (dirName(f.path) === d) names.add(baseName(f.path))
  }
  const dirs = all<{ path: string }>(
    db,
    'SELECT path FROM GraphDir WHERE tenant = ? AND drive = ?',
    tenant,
    drive,
  )
  for (const row of dirs) {
    if (row.path !== '' && dirName(row.path) === d) names.add(baseName(row.path))
  }
  return [...names].sort()
}

export async function folderSize(
  db: Db,
  tenant: string,
  drive: string,
  dir: string,
): Promise<number> {
  const d = norm(dir)
  const row =
    d === ''
      ? one<{ n: number | null }>(
          db,
          'SELECT SUM(size) AS n FROM GraphFile WHERE tenant = ? AND drive = ?',
          tenant,
          drive,
        )
      : one<{ n: number | null }>(
          db,
          'SELECT SUM(size) AS n FROM GraphFile WHERE tenant = ? AND drive = ? ' +
            'AND (path = ? OR path LIKE ?)',
          tenant,
          drive,
          d,
          like(`${d}/`),
        )
  return row?.n ?? 0
}

function under(table: string): string {
  return `${table} WHERE tenant = ? AND drive = ? AND path LIKE ?`
}

export async function removeAt(ctx: Ctx0, drive: string, path: string): Promise<boolean> {
  const p = norm(path)
  const tenant = ctx.tenant
  const file = await fileAt(ctx.db, tenant, drive, p)
  if (file !== null) {
    exec(
      ctx.db,
      'DELETE FROM GraphFile WHERE tenant = ? AND drive = ? AND path = ?',
      tenant,
      drive,
      p,
    )
    exec(
      ctx.db,
      'DELETE FROM GraphVersion WHERE tenant = ? AND drive = ? AND path = ?',
      tenant,
      drive,
      p,
    )
    await noteChange(ctx, drive, fileId(drive, file.seq), p)
    return true
  }
  if (!(await dirAt(ctx.db, tenant, drive, p)) || p === '') return false
  const prefix = `${p}/`
  const range = [tenant, drive, like(prefix)]
  exec(ctx.db, 'DELETE FROM GraphDir WHERE tenant = ? AND drive = ? AND path = ?', tenant, drive, p)
  exec(ctx.db, `DELETE FROM ${under('GraphDir')}`, ...range)
  exec(ctx.db, `DELETE FROM ${under('GraphFile')}`, ...range)
  exec(ctx.db, `DELETE FROM ${under('GraphVersion')}`, ...range)
  await noteChange(ctx, drive, folderId(drive, p), p)
  return true
}

// A file move keeps its version history: the vendor's rename is a metadata
// change, not a rewrite, so nothing about the file's past is lost. The row is
// deleted and recreated because `path` is part of the primary key.
export async function moveFile(
  ctx: Ctx0,
  drive: string,
  src: string,
  dest: string,
): Promise<FileRow | null> {
  const tenant = ctx.tenant
  const row = await fileAt(ctx.db, tenant, drive, src)
  if (row === null) return null
  await ensureParents(ctx, drive, dest)
  exec(
    ctx.db,
    'DELETE FROM GraphFile WHERE tenant = ? AND drive = ? AND path = ?',
    tenant,
    drive,
    src,
  )
  // A metadata change bumps eTag; cTag only moves with CONTENT, so the moved
  // row keeps the cTag it had and takes a fresh eTag.
  const moved = { ...row, path: dest, etag: `${drive}-tag${String(ctx.minter.next('tag'))}` }
  insertFile(ctx, moved)
  await moveVersions(ctx, drive, src, dest)
  await noteChange(ctx, drive, fileId(drive, moved.seq), dest)
  return moved
}

async function moveVersions(ctx: Ctx0, drive: string, src: string, dest: string): Promise<void> {
  const tenant = ctx.tenant
  const vers = all<VersionRow>(
    ctx.db,
    `${VERSION} WHERE tenant = ? AND drive = ? AND path = ? ORDER BY seq`,
    tenant,
    drive,
    src,
  )
  for (const v of vers) {
    exec(
      ctx.db,
      'DELETE FROM GraphVersion WHERE tenant = ? AND drive = ? AND path = ? AND versionId = ?',
      tenant,
      drive,
      src,
      v.versionId,
    )
    insertVersion(ctx, { ...v, path: dest })
  }
}

// A folder a move brings to `path`, with the times it had there.
async function placeDir(ctx: Ctx0, drive: string, path: string, stamps: DirStamps): Promise<void> {
  await ensureParents(ctx, drive, path)
  insertDir(ctx, drive, path, stamps)
  await noteChange(ctx, drive, folderId(drive, path), path)
}

// A folder move relocates the folder row, every descendant row, and every
// descendant's versions, so a rename does not silently drop history. The
// moved folder itself is changed by the move and takes a new modified time;
// what is inside it only changes path and keeps its own.
export async function moveDir(ctx: Ctx0, drive: string, src: string, dest: string): Promise<void> {
  const tenant = ctx.tenant
  const prefix = `${src}/`
  const was = await dirStamps(ctx.db, tenant, drive, src)
  exec(
    ctx.db,
    'DELETE FROM GraphDir WHERE tenant = ? AND drive = ? AND path = ?',
    tenant,
    drive,
    src,
  )
  await noteChange(ctx, drive, folderId(drive, src), src)
  const moved =
    was === null ? madeNow(ctx) : { created: was.created, modified: ctx.clock.nowIso(false) }
  await placeDir(ctx, drive, dest, moved)
  const dirs = all<{ path: string } & DirStamps>(
    ctx.db,
    `SELECT path, created, modified FROM ${under('GraphDir')} ORDER BY seq`,
    tenant,
    drive,
    like(prefix),
  )
  for (const row of dirs) {
    exec(
      ctx.db,
      'DELETE FROM GraphDir WHERE tenant = ? AND drive = ? AND path = ?',
      tenant,
      drive,
      row.path,
    )
    await placeDir(ctx, drive, `${dest}${row.path.slice(src.length)}`, row)
  }
  const files = all<FileRow>(
    ctx.db,
    `${FILE} WHERE tenant = ? AND drive = ? AND path LIKE ? ORDER BY seq`,
    tenant,
    drive,
    like(prefix),
  )
  for (const row of files) {
    const to = `${dest}${row.path.slice(src.length)}`
    exec(
      ctx.db,
      'DELETE FROM GraphFile WHERE tenant = ? AND drive = ? AND path = ?',
      tenant,
      drive,
      row.path,
    )
    insertFile(ctx, { ...row, path: to })
    await moveVersions(ctx, drive, row.path, to)
    await noteChange(ctx, drive, fileId(drive, row.seq), to)
  }
}

export async function copyDir(
  ctx: Ctx0,
  fromDrive: string,
  toDrive: string,
  src: string,
  dest: string,
): Promise<void> {
  await addDir(ctx, toDrive, dest)
  const prefix = `${src}/`
  const files = all<FileRow>(
    ctx.db,
    `${FILE} WHERE tenant = ? AND drive = ? AND path LIKE ? ORDER BY seq`,
    ctx.tenant,
    fromDrive,
    like(prefix),
  )
  for (const row of files) {
    await writeFile(ctx, toDrive, `${dest}${row.path.slice(src.length)}`, row.content)
  }
  const dirs = all<{ path: string }>(
    ctx.db,
    `SELECT path FROM ${under('GraphDir')}`,
    ctx.tenant,
    fromDrive,
    like(prefix),
  )
  for (const row of dirs) {
    await addDir(ctx, toDrive, `${dest}${row.path.slice(src.length)}`)
  }
}

export async function versionsOf(
  db: Db,
  tenant: string,
  drive: string,
  path: string,
): Promise<{ id: string; lastModifiedDateTime: string }[]> {
  const rows = all<{ versionId: string; modified: string }>(
    db,
    'SELECT versionId, modified FROM GraphVersion WHERE tenant = ? AND drive = ? AND path = ? ' +
      'ORDER BY seq',
    tenant,
    drive,
    norm(path),
  )
  // Real Graph lists versions newest-first.
  return rows.reverse().map((v) => ({ id: v.versionId, lastModifiedDateTime: v.modified }))
}

/** Every listed path's versions, each list newest-first as versionsOf has it. */
export async function versionsFor(
  db: Db,
  tenant: string,
  drive: string,
  paths: string[],
): Promise<Map<string, { id: string; lastModifiedDateTime: string }[]>> {
  const out = new Map<string, { id: string; lastModifiedDateTime: string }[]>()
  if (paths.length === 0) return out
  const rows = all<{ path: string; versionId: string; modified: string }>(
    db,
    'SELECT path, versionId, modified FROM GraphVersion WHERE tenant = ? AND drive = ? ' +
      'AND path IN (SELECT value FROM json_each(?)) ORDER BY seq',
    tenant,
    drive,
    JSON.stringify(paths),
  )
  for (const v of rows) {
    const list = out.get(v.path) ?? []
    list.push({ id: v.versionId, lastModifiedDateTime: v.modified })
    out.set(v.path, list)
  }
  for (const list of out.values()) list.reverse()
  return out
}

/** One version's bytes, or null. */
export async function versionBytes(
  db: Db,
  tenant: string,
  drive: string,
  path: string,
  versionId: string,
): Promise<Uint8Array | null> {
  const row = one<{ content: Uint8Array }>(
    db,
    'SELECT content FROM GraphVersion WHERE tenant = ? AND drive = ? AND path = ? AND versionId = ?',
    tenant,
    drive,
    norm(path),
    versionId,
  )
  return row?.content ?? null
}

/** Every file in a drive, metadata and bytes. */
export async function driveFiles(db: Db, tenant: string, drive: string): Promise<FileRow[]> {
  return all<FileRow>(db, `${FILE} WHERE tenant = ? AND drive = ?`, tenant, drive)
}

/** Every file's metadata in a drive, without its bytes, and every folder with its times. */
export async function driveIndex(
  db: Db,
  tenant: string,
  drive: string,
): Promise<{ files: Omit<FileRow, 'content'>[]; dirs: ({ path: string } & DirStamps)[] }> {
  const files = all<Omit<FileRow, 'content'>>(
    db,
    'SELECT drive, path, size, ctag, etag, modified, seq FROM GraphFile WHERE tenant = ? AND drive = ?',
    tenant,
    drive,
  )
  const dirs = all<{ path: string } & DirStamps>(
    db,
    'SELECT path, created, modified FROM GraphDir WHERE tenant = ? AND drive = ?',
    tenant,
    drive,
  )
  return { files, dirs }
}

export async function saveMonitor(ctx: Ctx0, payload: JsonValue): Promise<string> {
  const n = ctx.minter.next('op')
  const token = `op${String(n)}`
  exec(
    ctx.db,
    'INSERT INTO GraphMonitor (tenant, token, payload, seq) VALUES (?, ?, ?, ?)',
    ctx.tenant,
    token,
    JSON.stringify(payload),
    n,
  )
  return token
}

/** A monitor's saved payload, or null. */
export async function monitorPayload(
  db: Db,
  tenant: string,
  token: string,
): Promise<string | null> {
  const row = one<{ payload: string }>(
    db,
    'SELECT payload FROM GraphMonitor WHERE tenant = ? AND token = ?',
    tenant,
    token,
  )
  return row?.payload ?? null
}

export async function uploadAt(db: Db, tenant: string, token: string): Promise<UploadRow | null> {
  return one<UploadRow>(
    db,
    'SELECT token, drive, path, buffer, behavior, seq FROM GraphUpload WHERE tenant = ? AND token = ?',
    tenant,
    token,
  )
}

export async function saveUpload(ctx: Ctx0, row: UploadRow): Promise<void> {
  exec(
    ctx.db,
    'INSERT INTO GraphUpload (tenant, token, drive, path, buffer, behavior, seq) ' +
      `VALUES (?, ?, ?, ?, ${BYTES}, ?, ?)`,
    ctx.tenant,
    row.token,
    row.drive,
    row.path,
    ...bytes(row.buffer),
    row.behavior,
    row.seq,
  )
}

export async function growUpload(
  db: Db,
  tenant: string,
  token: string,
  buffer: Uint8Array,
): Promise<void> {
  exec(
    db,
    `UPDATE GraphUpload SET buffer = ${BYTES} WHERE tenant = ? AND token = ?`,
    ...bytes(buffer),
    tenant,
    token,
  )
}

export async function dropUpload(db: Db, tenant: string, token: string): Promise<void> {
  exec(db, 'DELETE FROM GraphUpload WHERE tenant = ? AND token = ?', tenant, token)
}

export async function conflictFree(
  db: Db,
  tenant: string,
  drive: string,
  path: string,
): Promise<boolean> {
  return (await fileAt(db, tenant, drive, path)) === null && !(await dirAt(db, tenant, drive, path))
}

export { joinPath }
