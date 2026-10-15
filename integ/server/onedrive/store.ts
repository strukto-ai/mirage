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

import type { Clock, JsonValue, Minter } from '../kit/typescript/index.ts'
import { DEFAULT_DRIVE, ENRICH_MARKER, OFFICE_EXTENSIONS, type C } from './config.ts'
import { baseName, dirName, joinPath, norm } from './paths.ts'

export interface FileRow {
  drive: string
  path: string
  content: Uint8Array
  ctag: string
  etag: string
  modified: string
  seq: number
}

export interface Ctx0 {
  db: C
  tenant: string
  clock: Clock
  minter: Minter
}

function fileKey(tenant: string, drive: string, path: string) {
  return { tenant_drive_path: { tenant, drive, path } }
}

export async function drives(db: C, tenant: string): Promise<string[]> {
  const rows = await db.graphDrive.findMany({ where: { tenant }, orderBy: { seq: 'asc' } })
  return rows.map((r) => r.key)
}

// A drive named on a URL that no fixture declared is not an error the caller
// can act on: the vendor would 404 the drive itself. The default drive always
// exists, because /me/drive has to resolve before anything has been declared.
export async function hasDrive(db: C, tenant: string, key: string): Promise<boolean> {
  if (key === DEFAULT_DRIVE) return true
  return (await db.graphDrive.findUnique({ where: { tenant_key: { tenant, key } } })) !== null
}

// The provisioning write behind `PUT /drives/:key`. Idempotent, so an adapter
// that declares the same drive once per mount does not have to check first.
export async function addDrive(ctx: Ctx0, key: string): Promise<void> {
  const found = await ctx.db.graphDrive.findUnique({
    where: { tenant_key: { tenant: ctx.tenant, key } },
  })
  if (found !== null) return
  await ctx.db.graphDrive.create({
    data: {
      tenant: ctx.tenant,
      key,
      isDefault: key === DEFAULT_DRIVE,
      seq: ctx.minter.next('drive'),
    },
  })
}

export async function fileAt(
  db: C,
  tenant: string,
  drive: string,
  path: string,
): Promise<FileRow | null> {
  return db.graphFile.findUnique({ where: fileKey(tenant, drive, norm(path)) })
}

export async function dirAt(db: C, tenant: string, drive: string, path: string): Promise<boolean> {
  const p = norm(path)
  if (p === '') return true
  return (await db.graphDir.findUnique({ where: fileKey(tenant, drive, p) })) !== null
}

export async function ensureParents(ctx: Ctx0, drive: string, path: string): Promise<void> {
  let parent = dirName(norm(path))
  const missing: string[] = []
  while (parent !== '') {
    missing.push(parent)
    parent = dirName(parent)
  }
  for (const dir of missing.reverse()) {
    const found = await ctx.db.graphDir.findUnique({ where: fileKey(ctx.tenant, drive, dir) })
    if (found === null) {
      await ctx.db.graphDir.create({
        data: { tenant: ctx.tenant, drive, path: dir, seq: ctx.minter.next('dir') },
      })
      await noteChange(ctx, drive, folderId(drive, dir), dir)
    }
  }
}

export async function addDir(ctx: Ctx0, drive: string, path: string): Promise<void> {
  await ensureParents(ctx, drive, path)
  const p = norm(path)
  if (p === '') return
  const found = await ctx.db.graphDir.findUnique({ where: fileKey(ctx.tenant, drive, p) })
  if (found !== null) return
  await ctx.db.graphDir.create({
    data: { tenant: ctx.tenant, drive, path: p, seq: ctx.minter.next('dir') },
  })
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
  db: C,
  tenant: string,
  drive: string,
  id: string,
): Promise<FileRow | null> {
  const prefix = `${drive}:file:`
  if (!id.startsWith(prefix)) return null
  const seq = Number(id.slice(prefix.length))
  if (!Number.isInteger(seq)) return null
  return db.graphFile.findFirst({ where: { tenant, drive, seq } })
}

/** Record that an item changed and where it now is, for the next /delta read. */
export async function noteChange(
  ctx: Ctx0,
  drive: string,
  itemId: string,
  path: string,
): Promise<void> {
  await ctx.db.graphChange.create({
    data: { tenant: ctx.tenant, drive, itemId, path: norm(path), seq: ctx.minter.next('change') },
  })
}

/** Each change after `after`, oldest first. */
export async function changesAfter(
  db: C,
  tenant: string,
  drive: string,
  after: number,
): Promise<{ itemId: string; path: string }[]> {
  return db.graphChange.findMany({
    where: { tenant, drive, seq: { gt: after } },
    orderBy: { seq: 'asc' },
    select: { itemId: true, path: true },
  })
}

/** The seq of the newest change, 0 when the drive has none. */
export async function lastChange(db: C, tenant: string, drive: string): Promise<number> {
  const row = await db.graphChange.findFirst({
    where: { tenant, drive },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  })
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
  const prior = await ctx.db.graphVersion.count({ where: { tenant: ctx.tenant, drive, path: p } })
  const versionId = `${String(prior + 1)}.0`
  const stamp = ctx.clock.nowIso(false)
  await ctx.db.graphVersion.create({
    data: {
      tenant: ctx.tenant,
      drive,
      path: p,
      versionId,
      modified: stamp,
      content: body as Uint8Array<ArrayBuffer>,
      seq: ctx.minter.next('ver'),
    },
  })
  const row = await ctx.db.graphFile.upsert({
    where: fileKey(ctx.tenant, drive, p),
    update: {
      content: body as Uint8Array<ArrayBuffer>,
      size: body.length,
      ctag: tag,
      etag: tag,
      modified: stamp,
    },
    create: {
      tenant: ctx.tenant,
      drive,
      path: p,
      content: body as Uint8Array<ArrayBuffer>,
      size: body.length,
      ctag: tag,
      etag: tag,
      modified: stamp,
      seq: ctx.minter.next('file'),
    },
  })
  await noteChange(ctx, drive, fileId(drive, row.seq), p)
  return row
}

export async function childNames(
  db: C,
  tenant: string,
  drive: string,
  dir: string,
): Promise<string[]> {
  const d = norm(dir)
  const names = new Set<string>()
  // `select` matters more than it looks: without it Prisma reads every column,
  // so listing a directory deserialized every file BODY in the drive just to
  // look at path strings, once per folder rendered.
  const files = await db.graphFile.findMany({
    where: { tenant, drive },
    select: { path: true },
  })
  for (const f of files) {
    if (dirName(f.path) === d) names.add(baseName(f.path))
  }
  const dirs = await db.graphDir.findMany({
    where: { tenant, drive },
    select: { path: true },
  })
  for (const row of dirs) {
    if (row.path !== '' && dirName(row.path) === d) names.add(baseName(row.path))
  }
  return [...names].sort()
}

export async function folderSize(
  db: C,
  tenant: string,
  drive: string,
  dir: string,
): Promise<number> {
  const d = norm(dir)
  const scope =
    d === ''
      ? { tenant, drive }
      : { tenant, drive, OR: [{ path: d }, { path: { startsWith: `${d}/` } }] }
  const agg = await db.graphFile.aggregate({ where: scope, _sum: { size: true } })
  return agg._sum.size ?? 0
}

export async function removeAt(ctx: Ctx0, drive: string, path: string): Promise<boolean> {
  const p = norm(path)
  const tenant = ctx.tenant
  const file = await ctx.db.graphFile.findUnique({ where: fileKey(tenant, drive, p) })
  if (file !== null) {
    await ctx.db.graphFile.delete({ where: fileKey(tenant, drive, p) })
    await ctx.db.graphVersion.deleteMany({ where: { tenant, drive, path: p } })
    await noteChange(ctx, drive, fileId(drive, file.seq), p)
    return true
  }
  if (!(await dirAt(ctx.db, tenant, drive, p)) || p === '') return false
  const prefix = `${p}/`
  await ctx.db.graphDir.delete({ where: fileKey(tenant, drive, p) })
  await ctx.db.graphDir.deleteMany({ where: { tenant, drive, path: { startsWith: prefix } } })
  await ctx.db.graphFile.deleteMany({ where: { tenant, drive, path: { startsWith: prefix } } })
  await ctx.db.graphVersion.deleteMany({ where: { tenant, drive, path: { startsWith: prefix } } })
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
  const row = await ctx.db.graphFile.findUnique({ where: fileKey(tenant, drive, src) })
  if (row === null) return null
  await ensureParents(ctx, drive, dest)
  await ctx.db.graphFile.delete({ where: fileKey(tenant, drive, src) })
  // A metadata change bumps eTag; cTag only moves with CONTENT, so the moved
  // row keeps the cTag it had and takes a fresh eTag.
  const moved = await ctx.db.graphFile.create({
    data: { ...row, path: dest, etag: `${drive}-tag${String(ctx.minter.next('tag'))}` },
  })
  await moveVersions(ctx, drive, src, dest)
  await noteChange(ctx, drive, fileId(drive, moved.seq), dest)
  return moved
}

async function moveVersions(ctx: Ctx0, drive: string, src: string, dest: string): Promise<void> {
  const tenant = ctx.tenant
  const vers = await ctx.db.graphVersion.findMany({
    where: { tenant, drive, path: src },
    orderBy: { seq: 'asc' },
  })
  for (const v of vers) {
    await ctx.db.graphVersion.delete({
      where: {
        tenant_drive_path_versionId: { tenant, drive, path: src, versionId: v.versionId },
      },
    })
    await ctx.db.graphVersion.create({ data: { ...v, path: dest } })
  }
}

// A folder move relocates the folder row, every descendant row, and every
// descendant's versions, so a rename does not silently drop history.
export async function moveDir(ctx: Ctx0, drive: string, src: string, dest: string): Promise<void> {
  const tenant = ctx.tenant
  const prefix = `${src}/`
  await ctx.db.graphDir.deleteMany({ where: { tenant, drive, path: src } })
  await noteChange(ctx, drive, folderId(drive, src), src)
  await addDir(ctx, drive, dest)
  const dirs = await ctx.db.graphDir.findMany({
    where: { tenant, drive, path: { startsWith: prefix } },
  })
  for (const row of dirs) {
    await ctx.db.graphDir.delete({ where: fileKey(tenant, drive, row.path) })
    await addDir(ctx, drive, `${dest}${row.path.slice(src.length)}`)
  }
  const files = await ctx.db.graphFile.findMany({
    where: { tenant, drive, path: { startsWith: prefix } },
    orderBy: { seq: 'asc' },
  })
  for (const row of files) {
    const to = `${dest}${row.path.slice(src.length)}`
    await ctx.db.graphFile.delete({ where: fileKey(tenant, drive, row.path) })
    await ctx.db.graphFile.create({ data: { ...row, path: to } })
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
  const files = await ctx.db.graphFile.findMany({
    where: { tenant: ctx.tenant, drive: fromDrive, path: { startsWith: prefix } },
    orderBy: { seq: 'asc' },
  })
  for (const row of files) {
    await writeFile(ctx, toDrive, `${dest}${row.path.slice(src.length)}`, row.content)
  }
  const dirs = await ctx.db.graphDir.findMany({
    where: { tenant: ctx.tenant, drive: fromDrive, path: { startsWith: prefix } },
  })
  for (const row of dirs) {
    await addDir(ctx, toDrive, `${dest}${row.path.slice(src.length)}`)
  }
}

export async function versionsOf(
  db: C,
  tenant: string,
  drive: string,
  path: string,
): Promise<{ id: string; lastModifiedDateTime: string }[]> {
  const rows = await db.graphVersion.findMany({
    where: { tenant, drive, path: norm(path) },
    orderBy: { seq: 'asc' },
  })
  // Real Graph lists versions newest-first.
  return rows.reverse().map((v) => ({ id: v.versionId, lastModifiedDateTime: v.modified }))
}

export async function saveMonitor(ctx: Ctx0, payload: JsonValue): Promise<string> {
  const n = ctx.minter.next('op')
  const token = `op${String(n)}`
  await ctx.db.graphMonitor.create({
    data: { tenant: ctx.tenant, token, payload: JSON.stringify(payload), seq: n },
  })
  return token
}

export async function conflictFree(
  db: C,
  tenant: string,
  drive: string,
  path: string,
): Promise<boolean> {
  return (await fileAt(db, tenant, drive, path)) === null && !(await dirAt(db, tenant, drive, path))
}

export { joinPath }
