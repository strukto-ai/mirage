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

// The --json selections and exports follow gh 2.85.0, printed as Go
// 1.25.5's encoding/json prints them (MIT and BSD-3-Clause; see
// licenses/third_party/gh.txt and go.txt).

import { exported, list, pointer, struct, type Shape } from './shape.ts'

/** A GraphQL connection as gh reads one: its nodes, and whether more follow. */
export interface Connection {
  nodes?: unknown[]
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
}

export type Node = Record<string, unknown>

/**
 * A connection `gh pr view` and `gh issue view` read to its end: its
 * selection given the clause that picks the page after `$endCursor` (or no
 * clause, for a field read apart), and where the connection sits in an
 * answer.
 */
export interface Pages {
  readonly select: (after: string) => string
  readonly at: (node: Node) => Connection
}

/**
 * One `--json` field of an issue or a pull request: the GraphQL selection
 * gh 2.85 puts on the wire for it (read off its query builder, and captured
 * with `GH_DEBUG=api`), and gh's own export of the answer (`ExportData`).
 *
 * `view` marks a field `gh pr view` or `gh issue view` leaves out of its
 * main query: `never` for one it never asks github.com for, and `apart` for
 * one it reads in a query of its own. The list commands ask for both
 * inline. `pages` marks a connection the view commands read to its end.
 */
export interface Field {
  readonly select: string
  readonly view?: 'never' | 'apart'
  readonly pages?: Pages
  readonly export: (node: Node) => unknown
}

export type FieldTable = ReadonlyMap<string, Field>

/**
 * Reads a selection of the issue or pull request a line names, with
 * `$endCursor` bound to `cursor` when the selection reads a later page.
 */
export type Fetch = (selection: string, cursor?: string) => Promise<Node>

export function record(value: unknown): Node {
  return value !== null && typeof value === 'object' ? (value as Node) : {}
}

export function connection(value: unknown): Connection {
  return record(value) as Connection
}

export function nodesOf(value: unknown): unknown[] {
  const nodes = connection(value).nodes
  return Array.isArray(nodes) ? nodes : []
}

// gh's CommentAuthor: a comment's or a review's author prints its login alone.
export const LOGIN = struct(['login', 'string'])
const USER = struct(
  ['id', 'string'],
  ['login', 'string'],
  ['name', 'string'],
  ['databaseId', 'int'],
)
const LABEL = struct(
  ['id', 'string'],
  ['name', 'string'],
  ['description', 'string'],
  ['color', 'string'],
)
// Its `url` is `omitempty`, and gh always asks for it, so it always prints.
const COMMENT = struct(
  ['id', 'string'],
  ['author', LOGIN],
  ['authorAssociation', 'string'],
  ['body', 'string'],
  ['createdAt', 'time'],
  ['includesCreatedEdit', 'bool'],
  ['isMinimized', 'bool'],
  ['minimizedReason', 'string'],
  ['reactionGroups', 'reactions'],
  ['url', 'string'],
  ['viewerDidAuthor', 'bool'],
)
// The maps gh builds by hand print their keys sorted, as Go's encoder does.
const REFERENCE = struct(
  ['id', 'string'],
  ['number', 'int'],
  [
    'repository',
    struct(
      ['id', 'string'],
      ['name', 'string'],
      ['owner', struct(['id', 'string'], ['login', 'string'])],
    ),
  ],
  ['url', 'string'],
)
const STATUS = struct(['optionId', 'string'], ['name', 'string'])
const PROJECT_CARD = struct(
  ['project', struct(['name', 'string'])],
  ['column', struct(['name', 'string'])],
)

export const AFTER = ', after: $endCursor'

const comments = (after: string): string =>
  `comments(first: 100${after}) {nodes {id,author{login,...on User{id,name}},authorAssociation,` +
  'body,createdAt,includesCreatedEdit,isMinimized,minimizedReason,' +
  'reactionGroups{content,users{totalCount}},url,viewerDidAuthor},' +
  'pageInfo{hasNextPage,endCursor},totalCount}'
const PROJECT_ITEMS =
  'projectItems(first:100){nodes{id, project{id,title}, status:fieldValueByName(name: ' +
  '"Status") { ... on ProjectV2ItemFieldSingleSelectValue{optionId,name}}},totalCount}'
const projectItemsAlone = (after: string): string =>
  `projectItems(first: 100${after}){totalCount,nodes{id,project{id,title},` +
  'status:fieldValueByName(name: "Status"){... on ProjectV2ItemFieldSingleSelectValue' +
  '{optionId,name}}},pageInfo{hasNextPage,endCursor}}'

// The refusals gh reads as "this token or host has no Projects", which leave
// project items empty rather than failing a view.
const PROJECTS_V2_IGNORABLE = [
  "field requires one of the following scopes: ['read:project']",
  "Field 'projectsV2' doesn't exist on type 'User'",
  "Field 'projectsV2' doesn't exist on type 'Repository'",
  "Field 'projectsV2' doesn't exist on type 'Organization'",
  "Field 'projectItems' doesn't exist on type 'Issue'",
  "Field 'projectItems' doesn't exist on type 'PullRequest'",
]

function projectItemsOf(node: Node): unknown[] {
  return nodesOf(node.projectItems).map((item) => {
    const row = record(item)
    return {
      status: exported(row.status, STATUS),
      title: exported(record(row.project).title, 'string'),
    }
  })
}

export function plain(name: string, shape: Shape, select = name): readonly [string, Field] {
  return [name, { select, export: (node) => exported(node[name], shape) }]
}

export function nodes(
  name: string,
  select: string,
  item: Shape,
  pages?: Pages,
): readonly [string, Field] {
  const spec: Field = {
    select,
    export: (node) => exported(connection(node[name]).nodes, list(item)),
  }
  return [name, pages === undefined ? spec : { ...spec, pages }]
}

export function paged(name: string, select: (after: string) => string): Pages {
  return { select, at: (node) => connection(node[name]) }
}

/**
 * A list of references to issues or pull requests in some repository, the
 * shape gh gives both `closingIssuesReferences` and
 * `closedByPullRequestsReferences`: always a list, read to its end.
 */
export function references(name: string): readonly [string, Field] {
  const select = (after: string): string =>
    `${name}(first: 100${after}) {nodes {id,number,url,` +
    'repository {id,name,owner {id,login}}}pageInfo{hasNextPage,endCursor}}'
  return [
    name,
    {
      select: select(''),
      pages: paged(name, select),
      export: (node) => nodesOf(node[name]).map((item) => exported(item, REFERENCE)),
    },
  ]
}

/**
 * The fields issues and pull requests share, as gh 2.85's
 * `sharedIssuePRFields` names them. `projectItems` is read apart by both
 * views; `projectCards` is asked for as it stands, and each command says
 * whether its view does.
 */
export const SHARED_FIELDS: readonly (readonly [string, Field])[] = [
  nodes('assignees', 'assignees(first:100){nodes{id,login,name},totalCount}', USER),
  plain('author', 'author', 'author{login,...on User{id,name}}'),
  plain('body', 'string'),
  plain('closed', 'bool'),
  plain('closedAt', 'raw'),
  nodes('comments', comments(''), COMMENT, paged('comments', comments)),
  plain('createdAt', 'time'),
  plain('id', 'string'),
  nodes('labels', 'labels(first:100){nodes{id,name,description,color},totalCount}', LABEL),
  plain(
    'milestone',
    pointer(['number', 'int'], ['title', 'string'], ['description', 'string'], ['dueOn', 'raw']),
    'milestone{number,title,description,dueOn}',
  ),
  plain('number', 'int'),
  nodes(
    'projectCards',
    'projectCards(first:100){nodes{project{name}column{name}},totalCount}',
    PROJECT_CARD,
  ),
  [
    'projectItems',
    {
      select: PROJECT_ITEMS,
      view: 'apart',
      pages: paged('projectItems', projectItemsAlone),
      export: projectItemsOf,
    },
  ],
  plain('reactionGroups', 'reactions', 'reactionGroups{content,users{totalCount}}'),
  plain('state', 'string'),
  plain('title', 'string'),
  plain('updatedAt', 'time'),
  plain('url', 'string'),
]

/**
 * The GraphQL selection for the fields named, in their order, each once. A
 * view leaves out the fields it reads some other way.
 */
export function selection(table: FieldTable, names: readonly string[], forView: boolean): string {
  return [...new Set(names)]
    .map((name) => table.get(name))
    .filter((spec): spec is Field => spec !== undefined && !(forView && spec.view !== undefined))
    .map((spec) => spec.select)
    .join(',')
}

/** One answer as gh exports the fields asked for. */
export function exportedNode(table: FieldTable, node: Node, fields: readonly string[]): Node {
  const row: Node = {}
  for (const field of fields) {
    const spec = table.get(field)
    if (spec !== undefined) row[field] = spec.export(node)
  }
  return row
}

/** Read the rest of one connection into the answer that holds its first page. */
async function readToEnd(fetch: Fetch, node: Node, pages: Pages): Promise<void> {
  const first = pages.at(node)
  const rows = [...nodesOf(first)]
  let info = first.pageInfo
  while (info?.hasNextPage === true && typeof info.endCursor === 'string') {
    const cursor = info.endCursor
    const page = pages.at(await fetch(pages.select(AFTER), cursor))
    for (const item of nodesOf(page)) rows.push(item)
    info = page.pageInfo
    if (info?.endCursor === cursor) throw new Error('GitHub returned a non-advancing cursor')
  }
  first.nodes = rows
}

/** Project items, read the way gh reads them: apart, and none without the scope. */
async function projectItemsApart(fetch: Fetch, pages: Pages): Promise<Connection> {
  try {
    const node = await fetch(pages.select(''))
    await readToEnd(fetch, node, pages)
    return pages.at(node)
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (PROJECTS_V2_IGNORABLE.some((refusal) => message.includes(refusal))) return { nodes: [] }
    throw error
  }
}

/**
 * Finish reading a view's answer: every connection gh follows read to its
 * end, and the fields it reads apart read that way, through `fetch`.
 */
export async function readRest(
  table: FieldTable,
  node: Node,
  fields: readonly string[],
  fetch: Fetch,
): Promise<Node> {
  for (const field of new Set(fields)) {
    const spec = table.get(field)
    if (spec?.pages === undefined) continue
    if (spec.view === 'apart') node[field] = await projectItemsApart(fetch, spec.pages)
    else await readToEnd(fetch, node, spec.pages)
  }
  return node
}
