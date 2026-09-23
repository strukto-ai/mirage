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

import {
  BLOCK_TYPES,
  supportsChildren,
  validateChildren,
  validatePayload,
  validation,
} from './blocks.ts'
import type { Ctx, Minter, Reply } from '../kit/typescript/index.ts'
import type { C } from './config.ts'
import { MAX_PAGE_SIZE } from './config.ts'
import {
  fillSchema,
  normalizeBlockPayload,
  normalizeProperties,
  persistSchema,
  schemaOf,
  titleColumnOf,
  titleOfProperties,
  titleProp,
} from './props.ts'
import { markdownOf, metaOf } from './store.ts'
import { markdownToBlocks, richToMd } from './text.ts'
import { apiVersion, markdownReply } from './reads.ts'
import type {
  BlockSpec,
  BlockRow,
  CommentRow,
  DatabaseRow,
  Json,
  MetaRow,
  PageRow,
} from './types.ts'
import {
  apiError,
  asObject,
  blockJson,
  commentJson,
  cursorOf,
  databaseIdOf,
  defaultUrl,
  intOr,
  idAt,
  listJson,
  mintId,
  notFound,
  pageJson,
  pageOf,
} from './wire.ts'

async function createPage(
  db: C,
  tenant: string,
  meta: MetaRow,
  minter: Minter,
  body: Json,
  version: string,
): Promise<Reply> {
  const children = validateChildren(body.children === undefined ? [] : body.children)
  if (!Array.isArray(children)) return children
  if (body.children !== undefined && body.markdown !== undefined) {
    return validation('body.children and body.markdown cannot both be provided.')
  }
  const parent = asObject(body.parent)
  let parentType = 'workspace'
  let parentId: string | null = null
  if (typeof parent.page_id === 'string') {
    parentType = 'page_id'
    parentId = parent.page_id
  } else if (typeof parent.data_source_id === 'string') {
    // Rows are addressed by data source since 2025-09-03, but storage keys
    // them by database, so the parent resolves back one hop here.
    const all = (await db.notionDatabase.findMany({ where: { tenant } })) as DatabaseRow[]
    const owner = databaseIdOf(parent.data_source_id, all)
    if (owner === null) return notFound('data source', parent.data_source_id)
    parentType = 'database_id'
    parentId = owner
  } else if (typeof parent.database_id === 'string') {
    parentType = 'database_id'
    parentId = parent.database_id
  } else if (parent.workspace !== true) {
    return apiError(400, 'validation_error', 'body.parent should be defined.')
  }
  if (parentType === 'page_id' && parentId !== null) {
    const owner = await db.notionPage.findFirst({ where: { tenant, id: parentId } })
    if (owner === null) return notFound('page', parentId)
  }
  // The owner is read once and serves three purposes: the parent check, the
  // column schema a written property is normalized against, and the name of
  // the title column a markdown-only create files its heading under.
  let owner: DatabaseRow | null = null
  if (parentType === 'database_id' && parentId !== null) {
    owner = (await db.notionDatabase.findFirst({
      where: { tenant, id: parentId },
    })) as DatabaseRow | null
    if (owner === null) return notFound('database', parentId)
  }
  const schema = schemaOf(owner)
  const schemaBefore = JSON.stringify(schema)
  const properties = normalizeProperties(asObject(body.properties), schema)
  // `ntn pages create --content` sends Markdown rather than properties; the
  // first heading becomes the title, exactly as the official CLI documents.
  const markdown = typeof body.markdown === 'string' ? body.markdown : ''
  const fromMarkdown = markdown === '' ? [] : markdownToBlocks(markdown)
  let title = titleOfProperties(properties)
  if (title === '' && fromMarkdown.length > 0) {
    const head = asObject(fromMarkdown[0])
    if (String(head.type).startsWith('heading_')) {
      title = richToMd(asObject(head[String(head.type)]).rich_text)
      fromMarkdown.shift()
    }
  }
  if (title !== '' && Object.keys(properties).length === 0) {
    Object.assign(properties, titleProp(title, titleColumnOf(schema)))
  }
  const specs = body.children === undefined ? validateChildren(fromMarkdown) : children
  if (!Array.isArray(specs)) return specs
  await persistSchema(db, tenant, owner, schema, schemaBefore)
  const id = mintId(minter, 'a0000000')
  await db.notionPage.create({
    data: {
      id,
      tenant,
      parentType,
      parentId,
      titleText: title,
      propertiesJson: JSON.stringify(
        owner === null ? properties : fillSchema(properties, schema, meta),
      ),
      iconJson: body.icon !== undefined ? JSON.stringify(body.icon) : null,
      coverJson: body.cover !== undefined ? JSON.stringify(body.cover) : null,
      createdTime: meta.createdTime,
      lastEditedTime: meta.lastEditedTime,
      createdBy: meta.createdBy,
      lastEditedBy: meta.lastEditedBy,
      url: defaultUrl(meta, id),
      position: await db.notionPage.count({ where: { tenant } }),
    },
  })
  if (parentType === 'page_id' && parentId !== null) {
    await db.notionBlock.create({
      data: {
        id,
        tenant,
        parentId,
        position: await db.notionBlock.count({ where: { tenant, parentId } }),
        type: 'child_page',
        payloadJson: JSON.stringify({ title }),
        hasChildren: false,
        createdTime: meta.createdTime,
        lastEditedTime: meta.lastEditedTime,
        createdBy: meta.createdBy,
        lastEditedBy: meta.lastEditedBy,
      },
    })
  }
  if (specs.length > 0) await insertChildren(db, tenant, meta, minter, id, specs, 0)
  const created = (await db.notionPage.findFirst({ where: { tenant, id } })) as PageRow
  return { status: 200, body: pageJson(created, version) }
}

async function appendChildren(
  db: C,
  tenant: string,
  meta: MetaRow,
  minter: Minter,
  parentId: string,
  body: Json,
): Promise<Reply> {
  const parentPage = await db.notionPage.findFirst({ where: { tenant, id: parentId } })
  const parentBlock = await db.notionBlock.findFirst({ where: { tenant, id: parentId } })
  if (parentPage === null && parentBlock === null) return notFound('block', parentId)
  if (
    parentPage === null &&
    parentBlock !== null &&
    !supportsChildren(parentBlock.type, JSON.parse(parentBlock.payloadJson) as Json)
  ) {
    return validation(`${parentBlock.type} blocks cannot have children.`)
  }
  const specs = validateChildren(body.children)
  if (!Array.isArray(specs)) return specs
  let at = await db.notionBlock.count({ where: { tenant, parentId } })
  let anchorPos: number | null = null
  const after = typeof body.after === 'string' ? body.after : null
  if (after !== null) {
    // `after` inserts the new blocks directly behind an existing child;
    // later siblings shift down. The live API reports a malformed id and
    // a well-formed one that is not a child of this parent with the SAME
    // validation message (probed on 2025-09-03).
    const anchor = await db.notionBlock.findFirst({ where: { tenant, id: after } })
    if (anchor === null || anchor.parentId !== parentId) {
      return apiError(
        400,
        'validation_error',
        `body failed validation: body.position.after_block.id should be a valid uuid, instead was \`"${after}"\`.`,
      )
    }
    await db.notionBlock.updateMany({
      where: { tenant, parentId, position: { gt: anchor.position } },
      data: { position: { increment: specs.length } },
    })
    anchorPos = anchor.position
    at = anchor.position + 1
  }
  const created = await insertChildren(db, tenant, meta, minter, parentId, specs, at)
  // With `after`, the live API answers with the inserted blocks AND every
  // sibling behind them, in order (probed); a plain append returns just
  // the inserted blocks.
  let results = created
  if (anchorPos !== null) {
    const fromAnchor = await db.notionBlock.findMany({
      where: { tenant, parentId, position: { gt: anchorPos } },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    })
    results = fromAnchor.map((row) => blockJson(row as BlockRow))
  }
  return { status: 200, body: listJson(results, null, 'block') }
}

async function insertChildren(
  db: C,
  tenant: string,
  meta: MetaRow,
  minter: Minter,
  parentId: string,
  specs: BlockSpec[],
  at: number,
): Promise<Json[]> {
  const created: Json[] = []
  for (const { type, payload, children } of specs) {
    const id = mintId(minter, 'b0000000')
    await db.notionBlock.create({
      data: {
        id,
        tenant,
        parentId,
        position: at++,
        type,
        payloadJson: JSON.stringify(normalizeBlockPayload(payload)),
        hasChildren: children.length > 0,
        createdTime: meta.createdTime,
        lastEditedTime: meta.lastEditedTime,
        createdBy: meta.createdBy,
        lastEditedBy: meta.lastEditedBy,
      },
    })
    if (children.length > 0) {
      await insertChildren(db, tenant, meta, minter, id, children, 0)
    }
    const row = (await db.notionBlock.findFirst({ where: { tenant, id } })) as BlockRow
    created.push(blockJson(row))
  }
  if (
    specs.length > 0 &&
    (await db.notionBlock.findFirst({ where: { tenant, id: parentId } })) !== null
  ) {
    await db.notionBlock.update({
      where: { tenant_id: { tenant, id: parentId } },
      data: { hasChildren: true },
    })
  }
  return created
}

async function createComment(
  db: C,
  tenant: string,
  meta: MetaRow,
  minter: Minter,
  body: Json,
): Promise<Reply> {
  const parent = asObject(body.parent)
  const parentId = typeof parent.page_id === 'string' ? parent.page_id : ''
  if (parentId === '') {
    return apiError(400, 'validation_error', 'body.parent.page_id should be a valid uuid.')
  }
  const owner = await db.notionPage.findFirst({ where: { tenant, id: parentId } })
  if (owner === null) return notFound('page', parentId)
  // One tick per comment: the discussion shares the comment's sequence number
  // so a scenario's ids stay easy to predict.
  const seq = minter.next('comment')
  const id = idAt('c0000000', seq)
  await db.notionComment.create({
    data: {
      id,
      tenant,
      parentType: 'page_id',
      parentId,
      discussionId: idAt('d0000000', seq),
      richTextJson: JSON.stringify(Array.isArray(body.rich_text) ? body.rich_text : []),
      createdTime: meta.createdTime,
      lastEditedTime: meta.lastEditedTime,
      createdBy: meta.createdBy,
      position: await db.notionComment.count({ where: { tenant, parentId } }),
    },
  })
  const row = (await db.notionComment.findFirst({ where: { tenant, id } })) as CommentRow
  return { status: 200, body: commentJson(row) }
}

// The read half of the comment surface. Without it a scenario can only write:
// an evaluator that grades what an agent said in a comment, or an agent that
// leaves a link in one and reads it back, both need this and both used to hit
// the route-not-found fallthrough.
//
// `block_id` names a page or a block, which is why existence is resolved
// against both tables the way deleteBlock resolves its operand. Comments are
// stored parented to a page today, so an existing block carrying none of them
// answers with an empty list rather than a 404, since upstream 404s only when
// the id itself is not shared with the integration.
async function listComments(db: C, tenant: string, q: URLSearchParams): Promise<Reply> {
  const blockId = q.get('block_id') ?? ''
  if (blockId === '') {
    return apiError(400, 'validation_error', 'block_id should be a valid uuid.')
  }
  const page = await db.notionPage.findFirst({ where: { tenant, id: blockId } })
  if (page === null) {
    const block = await db.notionBlock.findFirst({ where: { tenant, id: blockId } })
    if (block === null) return notFound('block', blockId)
  }
  // Upstream returns every discussion's comments in one ascending chronological
  // flat list, distinguishable by discussion_id, rather than grouped by thread.
  const rows = (await db.notionComment.findMany({
    where: { tenant, parentId: blockId },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
  })) as CommentRow[]
  const size = intOr(q.get('page_size'), MAX_PAGE_SIZE)
  return pageOf(rows.map(commentJson), cursorOf(q.get('start_cursor')), size, 'comment')
}

// A child page is one object in two tables (see the schema's NotionPage note),
// so trashing it has to move both rows: the NotionPage row is what /search and
// a database query read, the NotionBlock row is what the parent's children
// listing reads, and setting only one leaves the page gone from half the
// surfaces and present in the other half.
async function setTrashed(db: C, tenant: string, id: string, trashed: boolean): Promise<void> {
  const where = { tenant_id: { tenant, id } }
  if ((await db.notionPage.findFirst({ where: { tenant, id } })) !== null) {
    await db.notionPage.update({ where, data: { inTrash: trashed } })
  }
  if ((await db.notionBlock.findFirst({ where: { tenant, id } })) !== null) {
    await db.notionBlock.update({ where, data: { inTrash: trashed } })
  }
}

// DELETE /v1/blocks/{id} is the only delete verb the public API has, and the
// only one the MCP tool surface exposes (API-delete-a-block), so without it an
// MCP client cannot remove anything. Upstream: "Sets a Block object, including
// page blocks, to in_trash: true", which covers database rows, so this resolves
// a block id first and falls back to a page of the same id.
export async function deleteBlock(db: C, tenant: string, id: string): Promise<Reply> {
  const block = (await db.notionBlock.findFirst({
    where: { tenant, id },
  })) as BlockRow | null
  const page = (await db.notionPage.findFirst({
    where: { tenant, id },
  })) as PageRow | null
  if (block === null && page === null) return notFound('block', id)
  await setTrashed(db, tenant, id, true)
  // A page that owns no block row (a top-level page, or a database row) still
  // answers as a block, which is what "including page blocks" means.
  const body =
    block === null
      ? {
          object: 'block',
          id,
          type: 'child_page',
          has_children: false,
          child_page: { title: (page as PageRow).titleText },
        }
      : blockJson(block)
  return { status: 200, body: { ...body, archived: true, in_trash: true } }
}

async function updateBlock(db: C, tenant: string, id: string, body: Json): Promise<Reply> {
  const row = await db.notionBlock.findFirst({ where: { tenant, id } })
  if (row === null) return notFound('block', id)
  if (body.type !== undefined && body.type !== row.type) {
    return validation(`body.type should be "${row.type}".`)
  }
  for (const field of ['archived', 'in_trash']) {
    if (body[field] !== undefined && typeof body[field] !== 'boolean') {
      return validation(`body.${field} should be a boolean.`)
    }
  }
  for (const key of Object.keys(body)) {
    if (BLOCK_TYPES.has(key) && key !== row.type)
      return validation(`Block type cannot be changed from ${row.type} to ${key}.`)
  }
  const payload = JSON.parse(row.payloadJson) as Json
  const patch = body[row.type]
  if (patch !== undefined) {
    if (row.type === 'child_page' || row.type === 'child_database') {
      return validation(
        `Use the ${row.type === 'child_page' ? 'page' : 'database'} endpoint to update this block.`,
      )
    }
    const error = validatePayload(row.type, patch, `body.${row.type}`)
    if (error !== null) return error
    if (asObject(patch).children !== undefined)
      return validation('Block children cannot be updated with this endpoint.')
    Object.assign(payload, asObject(patch))
    if (row.hasChildren && !supportsChildren(row.type, payload)) {
      return validation('A block with children cannot be made non-toggleable.')
    }
  }
  const trash = body.in_trash ?? body.archived
  if (typeof trash === 'boolean') await setTrashed(db, tenant, id, trash)
  const updated = await db.notionBlock.update({
    where: { tenant_id: { tenant, id } },
    data: { payloadJson: JSON.stringify(normalizeBlockPayload(payload)) },
  })
  return {
    status: 200,
    body: { ...blockJson(updated), archived: updated.inTrash, in_trash: updated.inTrash },
  }
}

async function updatePage(
  db: C,
  tenant: string,
  id: string,
  body: Json,
  version: string,
): Promise<Reply> {
  const row = (await db.notionPage.findFirst({ where: { tenant, id } })) as PageRow | null
  if (row === null) return notFound('page', id)
  const data: Record<string, unknown> = {}
  // Two spellings of one bit, so `ntn pages trash` (in_trash) and an API or
  // MCP client (archived) reach the same state rather than half of it.
  const trash = typeof body.in_trash === 'boolean' ? body.in_trash : body.archived
  if (typeof trash === 'boolean') await setTrashed(db, tenant, id, trash)
  if (body.properties !== undefined) {
    const owner =
      row.parentType === 'database_id' && row.parentId !== null
        ? ((await db.notionDatabase.findFirst({
            where: { tenant, id: row.parentId },
          })) as DatabaseRow | null)
        : null
    const schema = schemaOf(owner)
    const schemaBefore = JSON.stringify(schema)
    const patch = normalizeProperties(asObject(body.properties), schema)
    await persistSchema(db, tenant, owner, schema, schemaBefore)
    const merged = { ...(JSON.parse(row.propertiesJson) as Json), ...patch }
    data.propertiesJson = JSON.stringify(merged)
    data.titleText = titleOfProperties(merged)
  }
  if (body.icon !== undefined) data.iconJson = JSON.stringify(body.icon)
  if (body.cover !== undefined) data.coverJson = JSON.stringify(body.cover)
  await db.notionPage.update({ where: { tenant_id: { tenant, id } }, data })
  const updated = (await db.notionPage.findFirst({ where: { tenant, id } })) as PageRow
  return { status: 200, body: pageJson(updated, version) }
}

// The route-shaped wrappers. Every write reads the same three pieces of
// per-tenant state, so they are fetched once here rather than by each handler:
// the meta row (the fixture's old `defaults`), the tenant's minter, and the
// parsed body.
export async function createPageRoute(ctx: Ctx<C>): Promise<Reply> {
  const meta = await metaOf(ctx.db, ctx.tenant)
  return createPage(ctx.db, ctx.tenant, meta, ctx.minter, asObject(ctx.json()), apiVersion(ctx))
}

export async function updatePageRoute(ctx: Ctx<C>): Promise<Reply> {
  const id = ctx.params.id ?? ''
  return updatePage(ctx.db, ctx.tenant, id, asObject(ctx.json()), apiVersion(ctx))
}

export async function appendChildrenRoute(ctx: Ctx<C>): Promise<Reply> {
  const meta = await metaOf(ctx.db, ctx.tenant)
  return appendChildren(
    ctx.db,
    ctx.tenant,
    meta,
    ctx.minter,
    ctx.params.id ?? '',
    asObject(ctx.json()),
  )
}

export async function deleteBlockRoute(ctx: Ctx<C>): Promise<Reply> {
  return deleteBlock(ctx.db, ctx.tenant, ctx.params.id ?? '')
}

export async function listCommentsRoute(ctx: Ctx<C>): Promise<Reply> {
  return listComments(ctx.db, ctx.tenant, ctx.query)
}

export async function createCommentRoute(ctx: Ctx<C>): Promise<Reply> {
  const meta = await metaOf(ctx.db, ctx.tenant)
  return createComment(ctx.db, ctx.tenant, meta, ctx.minter, asObject(ctx.json()))
}

async function deleteBlockTree(db: C, tenant: string, id: string): Promise<void> {
  const children = await db.notionBlock.findMany({ where: { tenant, parentId: id } })
  for (const child of children) await deleteBlockTree(db, tenant, child.id)
  await db.notionBlock.delete({ where: { tenant_id: { tenant, id } } })
}

// `ntn pages edit --content` replaces a page's body wholesale, which the API
// models as one typed operation rather than a block-by-block diff.
export async function replaceMarkdown(ctx: Ctx<C>): Promise<Reply> {
  const id = ctx.params.id ?? ''
  const body = asObject(ctx.json())
  const row = await ctx.db.notionPage.findFirst({ where: { tenant: ctx.tenant, id } })
  if (row === null) return notFound('page', id)
  if (body.type !== 'replace_content') {
    return apiError(400, 'validation_error', 'body.type should be "replace_content".')
  }
  const replacement = asObject(body.replace_content).new_str
  if (typeof replacement !== 'string') {
    return apiError(400, 'validation_error', 'body.replace_content.new_str should be defined.')
  }
  const blocks = replacement === '' ? [] : markdownToBlocks(replacement)
  const specs = validateChildren(blocks)
  if (!Array.isArray(specs)) return specs
  const kept = await ctx.db.notionBlock.findMany({ where: { tenant: ctx.tenant, parentId: id } })
  for (const one of kept) {
    if (one.type === 'child_page' || one.type === 'child_database') continue
    await deleteBlockTree(ctx.db, ctx.tenant, one.id)
  }
  if (specs.length > 0) {
    const meta = await metaOf(ctx.db, ctx.tenant)
    const at = await ctx.db.notionBlock.count({ where: { tenant: ctx.tenant, parentId: id } })
    await insertChildren(ctx.db, ctx.tenant, meta, ctx.minter, id, specs, at)
  }
  const lines: string[] = []
  await markdownOf(ctx.db, ctx.tenant, id, 0, lines)
  return markdownReply(id, lines)
}

export async function updateBlockRoute(ctx: Ctx<C>): Promise<Reply> {
  return updateBlock(ctx.db, ctx.tenant, ctx.params.id ?? '', asObject(ctx.json()))
}
