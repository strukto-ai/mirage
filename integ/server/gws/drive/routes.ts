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

import type { JsonValue, KitRoute, Reply } from '../../kit/typescript/index.ts'
import { route } from '../wire/route.ts'
import type { RouteOpts } from '../wire/route.ts'
import { parseMultipartRelated } from '../gmail/mime.ts'
import type { C } from '../store/client.ts'
import type { GwsState } from '../store/state.ts'
import type { DriveItem, Permission, Revision } from '../store/types.ts'
import { asObj, asStr, asStrArr, asBool } from '../wire/json.ts'
import type { JsonObj } from '../wire/json.ts'
import { FOLDER_MIME, OWNER } from '../wire/mime.ts'
import { NOT_FOUND, googleError, header, media, noContent, ok } from '../wire/reply.ts'
import type { Ctx } from '../../kit/typescript/index.ts'
import { createDriveItem, deleteTree, fmtFile, pushRevision } from './item.ts'
import { exportFile, listFiles } from './list.ts'

// The old fake spelled a resource id `[^/:]+`, so a path whose id half holds
// an in-segment verb matched no route rather than being read as an id.
const ID: RouteOpts = { classes: { id: 'id' } }
const ID_WRITE: RouteOpts = { classes: { id: 'id' }, write: true }

const DEFAULT_GENERATE_COUNT = 10
const QUOTA_BYTES = 15 * 1024 * 1024 * 1024

type GwsCtx = Ctx<GwsState>

function fmtRevision(r: Revision): JsonObj {
  return {
    kind: 'drive#revision',
    id: r.id,
    modifiedTime: r.modifiedTime,
    md5Checksum: r.md5Checksum,
    size: String(r.content.length),
  }
}

function fileOr404(ctx: GwsCtx, key = 'id'): DriveItem | null {
  return ctx.db.files.get(ctx.params[key] ?? '') ?? null
}

function uploadCreate(ctx: GwsCtx): Reply {
  if (ctx.query.get('uploadType') === 'multipart') {
    const { metadata, media: bytes } = parseMultipartRelated(
      ctx.body,
      header(ctx.headers, 'content-type'),
    )
    const meta = asObj(JSON.parse(metadata) as JsonValue)
    const item = createDriveItem(
      ctx.db,
      String(meta.name ?? 'Untitled'),
      String(meta.mimeType ?? 'application/octet-stream'),
      asStrArr(meta.parents) ?? [],
      bytes,
    )
    return ok(fmtFile(item))
  }
  const item = createDriveItem(ctx.db, 'Untitled', 'application/octet-stream', [], ctx.body)
  return ok(fmtFile(item))
}

function uploadPatch(ctx: GwsCtx): Reply {
  const item = fileOr404(ctx)
  if (item === null) return NOT_FOUND
  item.content = ctx.body
  item.modifiedTime = ctx.db.now()
  pushRevision(item)
  return ok(fmtFile(item))
}

function createFile(ctx: GwsCtx): Reply {
  const body = asObj(ctx.json())
  // A caller may pin the id to one handed out by files.generateIds,
  // which is the only reason that method is useful.
  const pinned = asStr(body.id)
  if (pinned !== undefined && ctx.db.files.has(pinned)) {
    return googleError(409, 'A file with that id already exists.', 'ALREADY_EXISTS')
  }
  const item = createDriveItem(
    ctx.db,
    String(body.name ?? 'Untitled'),
    String(body.mimeType ?? 'application/octet-stream'),
    asStrArr(body.parents) ?? [],
    Buffer.alloc(0),
    pinned,
  )
  return ok(fmtFile(item))
}

function about(ctx: GwsCtx): Reply {
  return ok({
    kind: 'drive#about',
    user: { kind: 'drive#user', ...OWNER, permissionId: 'owner' },
    storageQuota: {
      limit: String(QUOTA_BYTES),
      usage: String([...ctx.db.files.values()].reduce((n, f) => n + f.content.length, 0)),
    },
  })
}

function createDrive(ctx: GwsCtx): Reply {
  const name = asStr(asObj(ctx.json()).name) ?? 'Untitled drive'
  const id = ctx.db.nextId('drive')
  ctx.db.drives.set(id, { id, name })
  // The drive itself acts as its root folder.
  const root = createDriveItem(ctx.db, name, FOLDER_MIME, [], Buffer.alloc(0), id)
  root.parents = []
  root.driveId = id
  return ok({ kind: 'drive#drive', id, name })
}

function patchDrive(ctx: GwsCtx): Reply {
  const drive = ctx.db.drives.get(ctx.params.id ?? '')
  if (drive === undefined) return NOT_FOUND
  const name = asStr(asObj(ctx.json()).name)
  if (name !== undefined) {
    drive.name = name
    // The shared drive's root folder carries the same name, so a rename that
    // touched only the drive record would leave the mounted tree showing the
    // old one.
    const root = ctx.db.files.get(drive.id)
    if (root !== undefined) root.name = name
  }
  return ok({ kind: 'drive#drive', id: drive.id, name: drive.name })
}

function deleteDrive(ctx: GwsCtx): Reply {
  const drive = ctx.db.drives.get(ctx.params.id ?? '')
  if (drive === undefined) return NOT_FOUND
  for (const item of [...ctx.db.files.values()]) {
    if (item.driveId === drive.id) deleteTree(ctx.db, item.id)
  }
  ctx.db.drives.delete(drive.id)
  return noContent()
}

function patchFile(ctx: GwsCtx): Reply {
  const item = fileOr404(ctx)
  if (item === null) return NOT_FOUND
  const body = asObj(ctx.json())
  const name = asStr(body.name)
  if (name !== undefined) {
    item.name = name
    const doc = ctx.db.docs.get(item.id)
    if (doc !== undefined) doc.title = name
    const sheet = ctx.db.sheets.get(item.id)
    if (sheet !== undefined) sheet.title = name
    const pres = ctx.db.presentations.get(item.id)
    if (pres !== undefined) pres.title = name
  }
  const trashed = asBool(body.trashed)
  if (trashed !== undefined) item.trashed = trashed
  const add = ctx.query.get('addParents')
  const remove = ctx.query.get('removeParents')
  if (add !== null) item.parents.push(...add.split(','))
  if (remove !== null) {
    const removed = new Set(remove.split(','))
    item.parents = item.parents.filter((p) => !removed.has(p))
    if (item.parents.length === 0) item.parents = ['root']
  }
  item.modifiedTime = ctx.db.now()
  return ok(fmtFile(item))
}

function copyFile(ctx: GwsCtx): Reply {
  const src = fileOr404(ctx)
  if (src === null) return NOT_FOUND
  const body = asObj(ctx.json())
  const copy = createDriveItem(
    ctx.db,
    String(body.name ?? `Copy of ${src.name}`),
    src.mimeType,
    asStrArr(body.parents) ?? [...src.parents],
    Buffer.from(src.content),
  )
  const srcDoc = ctx.db.docs.get(src.id)
  if (srcDoc !== undefined) ctx.db.docs.set(copy.id, { title: copy.name, text: srcDoc.text })
  const srcSheet = ctx.db.sheets.get(src.id)
  if (srcSheet !== undefined) {
    ctx.db.sheets.set(copy.id, {
      title: copy.name,
      nextSheetId: srcSheet.nextSheetId,
      tabs: srcSheet.tabs.map((t) => ({ ...t, cells: new Map(t.cells) })),
    })
  }
  const srcPres = ctx.db.presentations.get(src.id)
  if (srcPres !== undefined) {
    ctx.db.presentations.set(copy.id, {
      title: copy.name,
      slides: srcPres.slides.map((s) => ({ objectId: s.objectId, texts: new Map(s.texts) })),
    })
  }
  return ok(fmtFile(copy))
}

function addPermission(ctx: GwsCtx): Reply {
  const item = fileOr404(ctx)
  if (item === null) return NOT_FOUND
  const body = asObj(ctx.json())
  const email = asStr(body.emailAddress)
  const permission: Permission = {
    id: ctx.db.nextId('perm'),
    role: String(body.role ?? 'reader'),
    type: String(body.type ?? 'user'),
    ...(email === undefined ? {} : { emailAddress: email }),
  }
  item.permissions.push(permission)
  return ok({ kind: 'drive#permission', ...permission })
}

function findPermission(ctx: GwsCtx): [DriveItem, Permission] | Reply {
  const item = fileOr404(ctx)
  if (item === null) return NOT_FOUND
  const permission = item.permissions.find((p) => p.id === ctx.params.permissionId)
  if (permission === undefined) return googleError(404, 'Permission not found.', 'NOT_FOUND')
  return [item, permission]
}

export function driveRoutes(): KitRoute<C>[] {
  return [
    route('POST', '/upload/drive/v3/files', uploadCreate, { write: true }),
    route('PATCH', '/upload/drive/v3/files/:id', uploadPatch, { write: true }),

    route('GET', '/drive/v3/files', (ctx) => listFiles(ctx.db, ctx.query)),
    route('POST', '/drive/v3/files', createFile, { write: true }),
    route('GET', '/drive/v3/about', about),

    route('POST', '/drive/v3/drives', createDrive, { write: true }),
    route('GET', '/drive/v3/drives', (ctx) =>
      ok({
        kind: 'drive#driveList',
        drives: [...ctx.db.drives.values()].map((d) => ({ kind: 'drive#drive', ...d })),
      }),
    ),
    route(
      'GET',
      '/drive/v3/drives/:id',
      (ctx) => {
        const drive = ctx.db.drives.get(ctx.params.id ?? '')
        if (drive === undefined) return NOT_FOUND
        return ok({ kind: 'drive#drive', id: drive.id, name: drive.name })
      },
      ID,
    ),
    route('PATCH', '/drive/v3/drives/:id', patchDrive, ID_WRITE),
    route('DELETE', '/drive/v3/drives/:id', deleteDrive, ID_WRITE),

    // files.generateIds and files.emptyTrash sit at fixed names under /files,
    // so they must be declared before the files/{fileId} routes below, which
    // would otherwise read them as ids and 404.
    // A GET that WRITES: the whole point of generateIds is that the ids it
    // hands out are never handed out again, so it advances the mint counter
    // and the advance has to reach the store like any other.
    route(
      'GET',
      '/drive/v3/files/generateIds',
      (ctx) => {
        const count = Number.parseInt(ctx.query.get('count') ?? String(DEFAULT_GENERATE_COUNT), 10)
        const total = Number.isNaN(count) || count < 1 ? DEFAULT_GENERATE_COUNT : count
        return ok({
          kind: 'drive#generatedIds',
          space: ctx.query.get('space') ?? 'drive',
          ids: Array.from({ length: total }, () => ctx.db.nextId('f')),
        })
      },
      { write: true },
    ),
    route(
      'DELETE',
      '/drive/v3/files/trash',
      (ctx) => {
        for (const item of [...ctx.db.files.values()]) {
          if (item.trashed) deleteTree(ctx.db, item.id)
        }
        return noContent()
      },
      { write: true },
    ),

    route('POST', '/drive/v3/files/:id/copy', copyFile, { write: true }),
    route('GET', '/drive/v3/files/:id/export', (ctx) => {
      const item = fileOr404(ctx)
      if (item === null) return NOT_FOUND
      return exportFile(ctx.db, item, ctx.query.get('mimeType') ?? '')
    }),
    route('GET', '/drive/v3/files/:id/revisions', (ctx) => {
      const item = fileOr404(ctx)
      if (item === null) return NOT_FOUND
      return ok({ kind: 'drive#revisionList', revisions: item.revisions.map(fmtRevision) })
    }),
    route('GET', '/drive/v3/files/:id/revisions/:revisionId', (ctx) => {
      const item = fileOr404(ctx)
      const revision = item?.revisions.find((r) => r.id === ctx.params.revisionId)
      if (item === null || revision === undefined) return NOT_FOUND
      if (ctx.query.get('alt') === 'media') {
        return media(revision.content, header(ctx.headers, 'range'))
      }
      return ok(fmtRevision(revision))
    }),
    route(
      'DELETE',
      '/drive/v3/files/:id/revisions/:revisionId',
      (ctx) => {
        const item = fileOr404(ctx)
        if (item === null) return NOT_FOUND
        const before = item.revisions.length
        item.revisions = item.revisions.filter((r) => r.id !== ctx.params.revisionId)
        if (item.revisions.length === before) {
          return googleError(404, 'Revision not found.', 'NOT_FOUND')
        }
        return noContent()
      },
      { write: true },
    ),
    route('GET', '/drive/v3/files/:id/permissions', (ctx) => {
      const item = fileOr404(ctx)
      if (item === null) return NOT_FOUND
      return ok({
        kind: 'drive#permissionList',
        permissions: item.permissions.map((p) => ({ ...p })),
      })
    }),
    route('POST', '/drive/v3/files/:id/permissions', addPermission, { write: true }),
    route('GET', '/drive/v3/files/:id/permissions/:permissionId', (ctx) => {
      const found = findPermission(ctx)
      if (!Array.isArray(found)) return found
      return ok({ kind: 'drive#permission', ...found[1] })
    }),
    route(
      'PATCH',
      '/drive/v3/files/:id/permissions/:permissionId',
      (ctx) => {
        const found = findPermission(ctx)
        if (!Array.isArray(found)) return found
        // permissions.update takes only role (and expiration/expose flags a
        // mock has no model for); type is immutable on the live API.
        const role = asStr(asObj(ctx.json()).role)
        if (role !== undefined) found[1].role = role
        return ok({ kind: 'drive#permission', ...found[1] })
      },
      { write: true },
    ),
    route(
      'DELETE',
      '/drive/v3/files/:id/permissions/:permissionId',
      (ctx) => {
        const found = findPermission(ctx)
        if (!Array.isArray(found)) return found
        found[0].permissions = found[0].permissions.filter((p) => p.id !== ctx.params.permissionId)
        return noContent()
      },
      { write: true },
    ),

    route(
      'GET',
      '/drive/v3/files/:id',
      (ctx) => {
        const item = fileOr404(ctx)
        if (item === null) return NOT_FOUND
        if (ctx.query.get('alt') === 'media') {
          return media(item.content, header(ctx.headers, 'range'))
        }
        return ok(fmtFile(item))
      },
      ID,
    ),
    route('PATCH', '/drive/v3/files/:id', patchFile, ID_WRITE),
    route(
      'DELETE',
      '/drive/v3/files/:id',
      (ctx) => {
        const item = fileOr404(ctx)
        if (item === null) return NOT_FOUND
        deleteTree(ctx.db, item.id)
        return noContent()
      },
      ID_WRITE,
    ),
  ]
}
