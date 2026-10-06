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

import { FlagView } from '../../../spec/flag_view.ts'
import {
  createRepo,
  deleteRepo,
  editRepo,
  forkRepo,
  listRepos,
  listRepositoryFields,
  login,
  parseRepo,
  readReadme,
  renameRepo,
  repoHost,
  repoTopics,
  repositoryFields,
  setRepoTopics,
  viewRepo,
  type RepoRef,
} from '../../../../core/github/repo.ts'
import type { CommandFnResult } from '../../../config.ts'
import { UsageError } from '../../../errors.ts'
import { IOResult } from '../../../../io/types.ts'
import type { CLIInvocation } from '../../types.ts'
import {
  camel,
  checkHost,
  csvValues,
  ghBool,
  ghRepo,
  ghTransport,
  jsonFields,
  textOut,
  textValue,
  typedOut,
} from './accessor.ts'
import { GITHUB_HOST, REPO_EDIT_FIELDS } from './constants.ts'
import { GITHUB_API_BASE } from '../../../../core/github/client.ts'
import type { GhConfig } from '../../../../core/github/config.ts'
import { parseCommand, parseToKwargs } from '../../../spec/parser.ts'
import { findNode } from '../../walk.ts'
import { GIT } from '../git/index.ts'
import { clone as gitClone } from '../git/clone.ts'
import { splitMarked } from '../git/util.ts'
import { flagKwargName } from '../../../spec/constants.ts'
import { exported, list, pointer, struct, type Shape } from './shape.ts'

const OWNER = struct(['id', 'string'], ['login', 'string'])
const USER = struct(
  ['id', 'string'],
  ['login', 'string'],
  ['name', 'string'],
  ['databaseId', 'int'],
)
const COUNT = struct(['totalCount', 'int'])
// gh prints a related repository (a fork's parent, a template) as three facts.
const RELATED = pointer(['id', 'string'], ['name', 'string'], ['owner', OWNER])

/**
 * One `--json` field: the GraphQL selection gh sends for it and how the answer
 * prints. `unwrap` names gh's own flattening of a connection: its `nodes`,
 * its `edges`, or the topic inside each topic node, which prints null rather
 * than `[]` for a repository with none.
 */
interface RepoField {
  readonly select: string
  readonly shape: Shape
  readonly unwrap?: 'nodes' | 'edges' | 'topics'
}

function plain(name: string, shape: Shape): readonly [string, RepoField] {
  return [name, { select: name, shape }]
}

/**
 * Every field `gh repo view --json` and `gh repo list --json` accept in gh
 * 2.85, each with the selection gh put on the wire for it (captured with
 * `GH_DEBUG=api`) and the shape of gh's own `Repository` type.
 */
const REPO_FIELD_TABLE: ReadonlyMap<string, RepoField> = new Map<string, RepoField>([
  plain('archivedAt', 'raw'),
  [
    'assignableUsers',
    {
      select: 'assignableUsers(first:100){nodes{id,login,name}}',
      shape: list(USER),
      unwrap: 'nodes',
    },
  ],
  [
    'codeOfConduct',
    {
      select: 'codeOfConduct{key,name,url}',
      shape: pointer(['key', 'string'], ['name', 'string'], ['url', 'string']),
    },
  ],
  [
    'contactLinks',
    {
      select: 'contactLinks{about,name,url}',
      shape: list(struct(['about', 'string'], ['name', 'string'], ['url', 'string'])),
    },
  ],
  plain('createdAt', 'time'),
  ['defaultBranchRef', { select: 'defaultBranchRef{name}', shape: struct(['name', 'string']) }],
  plain('deleteBranchOnMerge', 'bool'),
  plain('description', 'string'),
  plain('diskUsage', 'int'),
  plain('forkCount', 'int'),
  [
    'fundingLinks',
    {
      select: 'fundingLinks{platform,url}',
      shape: list(struct(['platform', 'string'], ['url', 'string'])),
    },
  ],
  plain('hasDiscussionsEnabled', 'bool'),
  plain('hasIssuesEnabled', 'bool'),
  plain('hasProjectsEnabled', 'bool'),
  plain('hasWikiEnabled', 'bool'),
  plain('homepageUrl', 'string'),
  plain('id', 'string'),
  plain('isArchived', 'bool'),
  plain('isBlankIssuesEnabled', 'bool'),
  plain('isEmpty', 'bool'),
  plain('isFork', 'bool'),
  plain('isInOrganization', 'bool'),
  plain('isMirror', 'bool'),
  plain('isPrivate', 'bool'),
  plain('isSecurityPolicyEnabled', 'bool'),
  plain('isTemplate', 'bool'),
  plain('isUserConfigurationRepository', 'bool'),
  [
    'issueTemplates',
    {
      select: 'issueTemplates{name,title,body,about}',
      shape: list(
        struct(['name', 'string'], ['title', 'string'], ['body', 'string'], ['about', 'string']),
      ),
    },
  ],
  ['issues', { select: 'issues(states:OPEN){totalCount}', shape: COUNT }],
  [
    'labels',
    {
      select: 'labels(first:100){nodes{id,color,name,description}}',
      shape: list(
        struct(
          ['id', 'string'],
          ['name', 'string'],
          ['description', 'string'],
          ['color', 'string'],
        ),
      ),
      unwrap: 'nodes',
    },
  ],
  [
    'languages',
    {
      select: 'languages(first:100){edges{size,node{name}}}',
      shape: list(struct(['size', 'int'], ['node', struct(['name', 'string'])])),
      unwrap: 'edges',
    },
  ],
  [
    'latestRelease',
    {
      select: 'latestRelease{publishedAt,tagName,name,url}',
      shape: pointer(
        ['name', 'string'],
        ['tagName', 'string'],
        ['url', 'string'],
        ['publishedAt', 'time'],
      ),
    },
  ],
  [
    'licenseInfo',
    {
      select: 'licenseInfo{key,name,nickname}',
      shape: pointer(['key', 'string'], ['name', 'string'], ['nickname', 'string']),
    },
  ],
  [
    'mentionableUsers',
    {
      select: 'mentionableUsers(first:100){nodes{id,login,name}}',
      shape: list(USER),
      unwrap: 'nodes',
    },
  ],
  plain('mergeCommitAllowed', 'bool'),
  [
    'milestones',
    {
      select: 'milestones(first:100,states:OPEN){nodes{number,title,description,dueOn}}',
      shape: list(
        struct(['number', 'int'], ['title', 'string'], ['description', 'string'], ['dueOn', 'raw']),
      ),
      unwrap: 'nodes',
    },
  ],
  plain('mirrorUrl', 'string'),
  plain('name', 'string'),
  plain('nameWithOwner', 'string'),
  plain('openGraphImageUrl', 'string'),
  ['owner', { select: 'owner{id,login}', shape: OWNER }],
  ['parent', { select: 'parent{id,name,owner{id,login}}', shape: RELATED }],
  ['primaryLanguage', { select: 'primaryLanguage{name}', shape: pointer(['name', 'string']) }],
  [
    'projects',
    {
      select: 'projects(first:100,states:OPEN){nodes{id,name,number,body,resourcePath}}',
      shape: list(
        struct(['id', 'string'], ['name', 'string'], ['number', 'int'], ['resourcePath', 'string']),
      ),
      unwrap: 'nodes',
    },
  ],
  // gh has no flattening for this one, so it prints its Go struct as is:
  // the untagged `Nodes` field under its own capitalised name.
  [
    'projectsV2',
    {
      select:
        'projectsV2(first:100,query:"is:open"){nodes{id,number,title,resourcePath,closed,url}}',
      shape: struct([
        'Nodes',
        list(
          struct(
            ['id', 'string'],
            ['title', 'string'],
            ['number', 'int'],
            ['resourcePath', 'string'],
            ['closed', 'bool'],
            ['url', 'string'],
          ),
        ),
        'nodes',
      ]),
    },
  ],
  [
    'pullRequestTemplates',
    {
      select: 'pullRequestTemplates{body,filename}',
      shape: list(struct(['filename', 'string'], ['body', 'string'])),
    },
  ],
  ['pullRequests', { select: 'pullRequests(states:OPEN){totalCount}', shape: COUNT }],
  plain('pushedAt', 'raw'),
  plain('rebaseMergeAllowed', 'bool'),
  [
    'repositoryTopics',
    {
      select: 'repositoryTopics(first:100){nodes{topic{name}}}',
      shape: list(struct(['name', 'string'])),
      unwrap: 'topics',
    },
  ],
  plain('securityPolicyUrl', 'string'),
  plain('squashMergeAllowed', 'bool'),
  plain('sshUrl', 'string'),
  plain('stargazerCount', 'int'),
  ['templateRepository', { select: 'templateRepository{id,name,owner{id,login}}', shape: RELATED }],
  plain('updatedAt', 'time'),
  plain('url', 'string'),
  plain('usesCustomOpenGraphImage', 'bool'),
  plain('viewerCanAdminister', 'bool'),
  plain('viewerDefaultCommitEmail', 'string'),
  plain('viewerDefaultMergeMethod', 'string'),
  plain('viewerHasStarred', 'bool'),
  plain('viewerPermission', 'string'),
  plain('viewerPossibleCommitEmails', list('string')),
  plain('viewerSubscription', 'string'),
  plain('visibility', 'string'),
  ['watchers', { select: 'watchers{totalCount}', shape: COUNT }],
])

export const REPO_FIELDS: readonly string[] = [...REPO_FIELD_TABLE.keys()]

/** The GraphQL selection for the fields a line asked for, in its order. */
function repoSelection(fields: readonly string[]): string {
  return [...new Set(fields)].map((field) => REPO_FIELD_TABLE.get(field)?.select ?? field).join(',')
}

/** One repository's answer as gh exports the fields asked for. */
function exportedRepo(
  node: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  for (const field of fields) {
    const spec = REPO_FIELD_TABLE.get(field)
    if (spec === undefined) continue
    let value = node[field]
    const connection =
      value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
    if (spec.unwrap === 'nodes') value = connection?.nodes
    if (spec.unwrap === 'edges') value = connection?.edges
    if (spec.unwrap === 'topics') {
      const topics = Array.isArray(connection?.nodes)
        ? (connection.nodes as { topic?: unknown }[]).map((item) => item.topic)
        : []
      value = topics.length > 0 ? topics : null
    }
    row[field] = exported(value, spec.shape)
  }
  return row
}

function repo(value: unknown): Record<string, unknown> {
  const row = camel(value)
  const result = row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : {}
  if ('fullName' in result) {
    result.nameWithOwner = result.fullName
    delete result.fullName
  }
  if ('defaultBranch' in result) {
    result.defaultBranchRef = { name: result.defaultBranch }
    delete result.defaultBranch
  }
  if ('private' in result) {
    result.isPrivate = result.private
    delete result.private
  }
  if ('fork' in result) {
    result.isFork = result.fork
    delete result.fork
  }
  return result
}

/**
 * gh's own text view of a repository: two tab-separated header lines and
 * then the README verbatim, with the `--` separator omitted entirely when
 * there is no README. Probed against gh 2.85, whose description line is
 * present and empty for a repository that has none.
 */
export function summary(repo: unknown, readme: string | null): string {
  const fields = (repo ?? {}) as { full_name?: unknown; description?: unknown }
  const name = typeof fields.full_name === 'string' ? fields.full_name : ''
  const description = typeof fields.description === 'string' ? fields.description : ''
  const head = `name:\t${name}\ndescription:\t${description}\n`
  return readme === null ? head : `${head}--\n${readme}`
}

/**
 * `gh repo view`. With `--json` it asks GraphQL for exactly the fields named,
 * the way gh does, so every field gh accepts is answered in gh's own shape;
 * the text view reads the REST object and the README.
 */
export async function view(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const transport = ghTransport(inv.config)
  const ref = ghRepo(inv.config, inv.texts[0] ?? fl.asStr('repo'))
  const fields = jsonFields(fl, REPO_FIELDS)
  if (fields !== null) {
    const node = await repositoryFields(transport, ref, repoSelection(fields))
    return typedOut(exportedRepo(node, fields), fl, '', REPO_FIELDS)
  }
  const value = await viewRepo(transport, ref)
  return typedOut(value, fl, summary(value, await readReadme(transport, ref)), REPO_FIELDS)
}

/** `gh repo list`, over GraphQL for `--json` as `view` is. */
export async function listCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const transport = ghTransport(inv.config)
  const limit = fl.asInt('limit') ?? 30
  const fields = jsonFields(fl, REPO_FIELDS)
  if (fields !== null) {
    const nodes = await listRepositoryFields(transport, inv.texts[0], limit, repoSelection(fields))
    return typedOut(
      nodes.map((node) => exportedRepo(node, fields)),
      fl,
      '',
      REPO_FIELDS,
    )
  }
  const rows = (await listRepos(transport, inv.texts[0], limit)).map(repo)
  const human = rows
    .map(
      (row) =>
        `${textValue(row.nameWithOwner)}\t${textValue(row.description)}\t${textValue(row.visibility)}\t${textValue(row.updatedAt)}\n`,
    )
    .join('')
  return typedOut(rows, fl, human, REPO_FIELDS)
}

export async function createCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const spec = inv.texts[0] ?? ''
  if (spec === '') throw new Error('a repository name is required in noninteractive mode')
  const parts = spec.split('/')
  if (parts.length > 2 || parts.some((part) => part === '')) {
    throw new Error(`invalid repository name: "${spec}"`)
  }
  if (ghBool(fl, 'public') && ghBool(fl, 'private')) {
    throw new Error('--public and --private are mutually exclusive')
  }
  const owner = parts.length === 2 ? parts[0] : undefined
  const body: Record<string, unknown> = {
    name: parts.at(-1) ?? '',
    private: ghBool(fl, 'private'),
    auto_init: ghBool(fl, 'add_readme'),
  }
  const description = fl.asStr('description')
  const homepage = fl.asStr('homepage')
  if (description !== undefined) body.description = description
  if (homepage !== undefined) body.homepage = homepage
  const created = repo(await createRepo(ghTransport(inv.config), owner, body))
  return textOut(`${textValue(created.url)}\n`)
}

/**
 * Where the install's repositories are cloned from: github.com for GitHub's
 * own API, else the API host's own origin, which a GitHub Enterprise server
 * and a local stand-in serve git from.
 */
function cloneOrigin(config: GhConfig): string {
  const base = config.baseUrl
  if (base === undefined || base.replace(/\/+$/, '') === GITHUB_API_BASE) {
    return `https://${GITHUB_HOST}`
  }
  return new URL(base).origin
}

/**
 * The Authorization git sends GitHub for the install's token: Basic with the
 * token as the password, what gh's credential helper hands git.
 */
function tokenHeader(config: GhConfig): Record<string, string> {
  return { Authorization: `Basic ${btoa(`x-access-token:${config.token}`)}` }
}

/**
 * `gh repo clone`: mirage's `git clone` of the repository, the words after `--`
 * as git's options. The token rides only as the request's Authorization, never
 * on the line, in the config or in the output; a fork's `upstream` remote is
 * not added.
 */
export async function cloneCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  const config = inv.config as GhConfig
  const [names, gitflags] = splitMarked(inv.texts, inv.argv)
  const spec = names[0]
  if (spec === undefined) throw new Error('cannot clone: repository argument required')
  checkHost(config, repoHost(spec))
  const ref: RepoRef =
    !spec.includes('/') && !spec.includes(':')
      ? { owner: await login(ghTransport(config)), repo: spec }
      : parseRepo(spec)
  const url = `${cloneOrigin(config)}/${ref.owner}/${ref.repo}.git`
  const target = names[1] ?? ref.repo
  const leaf = findNode(GIT, ['clone'])?.node ?? GIT
  const cwd = inv.env.PWD ?? '/'
  const words = [...gitflags, url, target]
  const parsed = parseCommand(leaf, words, cwd, 'git clone', inv.env, true)
  const git: CLIInvocation = {
    config: null,
    argv: ['clone', ...words],
    paths: [],
    texts: parsed.args.map(([word]) => word),
    flags: { ...parseToKwargs(parsed), C: cwd },
    stdin: inv.stdin,
    env: inv.env,
    ...(inv.doors !== undefined ? { doors: inv.doors } : {}),
    spec: leaf,
  }
  return gitClone(git, tokenHeader(config))
}

/**
 * `gh repo fork`. gh clones a fork, or adds a remote for one, into the local
 * checkout, which a workspace does not have: `--clone` is refused, and so is
 * `--remote` without a repository, where it would name that checkout. gh
 * ignores `--remote` beside a repository, and `--clone=false` or
 * `--remote=false` asks for what this fork does anyway.
 */
export async function fork(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const org = fl.asStr('org')
  if (org === '') throw new Error('--org cannot be blank')
  if (fl.asStr('remote_name') === '') throw new Error('--remote-name cannot be blank')
  if (ghBool(fl, 'clone')) {
    throw new Error('--clone is not supported: there is no local checkout to clone into')
  }
  if (ghBool(fl, 'remote') && inv.texts[0] === undefined) {
    throw new Error('--remote is not supported: there is no local checkout to add a remote to')
  }
  const transport = ghTransport(inv.config)
  let source: RepoRef
  try {
    source = ghRepo(inv.config, inv.texts[0])
  } catch (err) {
    if (inv.texts[0] === undefined || !(err instanceof Error)) throw err
    throw new Error(`did not understand argument: ${err.message}`)
  }
  const name = fl.asStr('fork_name') ?? undefined
  const body: Record<string, unknown> = {}
  if (name !== undefined) body.name = name
  if (org !== undefined) body.organization = org
  if (ghBool(fl, 'default_branch_only')) body.default_branch_only = true
  const forked = (await forkRepo(transport, source, body)) as { full_name?: string }
  const full = forked.full_name ?? `${await login(transport)}/${name ?? source.repo}`
  return textOut(`✓ Created fork ${full}\n`)
}

export async function rename(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const transport = ghTransport(inv.config)
  // gh takes the *new name* as the operand and the repository to rename as
  // -R, which is the reverse of what the shape of the line suggests.
  const target = ghRepo(inv.config, fl.asStr('repo') ?? undefined)
  const name = inv.texts[0] ?? ''
  if (name === '') throw new Error('a new repository name is required')
  const renamed = (await renameRepo(transport, target, name)) as { full_name?: string }
  return textOut(`✓ Renamed repository ${renamed.full_name ?? name}\n`)
}

/**
 * `gh repo edit`: the settings named on the line in one `PATCH`, and topics
 * read and replaced whole when `--add-topic` or `--remove-topic` changes
 * them. With nothing to edit gh would prompt, so it refuses instead, and a
 * visibility change needs `--accept-visibility-change-consequences`. Like gh
 * writing to anything but a terminal, success prints nothing.
 */
export async function editCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags, inv.spec)
  const ref = ghRepo(inv.config, inv.texts[0])
  const body: Record<string, unknown> = {}
  const security: Record<string, unknown> = {}
  for (const field of REPO_EDIT_FIELDS) {
    const dest = flagKwargName(field.flag)
    if (fl.raw(dest) === undefined) continue
    if (field.kind === 'value') {
      body[field.field] = fl.asStr(dest)
    } else {
      const enabled = ghBool(fl, dest)
      if (field.kind === 'security') {
        security[field.field] = { status: enabled ? 'enabled' : 'disabled' }
      } else {
        body[field.field] = enabled
      }
    }
  }
  const adds = csvValues(fl.asList('add_topic'))
  const removes = csvValues(fl.asList('remove_topic'))
  const accepted = ghBool(fl, 'accept_visibility_change_consequences')
  const named =
    Object.keys(body).length + Object.keys(security).length + adds.length + removes.length > 0
  if (!named && !accepted) {
    throw new UsageError('specify properties to edit when not running interactively', 1)
  }
  if (body.visibility !== undefined && !accepted) {
    throw new UsageError(
      'use of --visibility flag requires --accept-visibility-change-consequences flag',
      1,
    )
  }
  const transport = ghTransport(inv.config)
  if (Object.keys(security).length > 0) {
    const node = await repositoryFields(transport, ref, 'viewerCanAdminister')
    if (node.viewerCanAdminister !== true) {
      throw new Error(
        'you do not have sufficient permissions to edit repository security and analysis features',
      )
    }
    body.security_and_analysis = security
  }
  if (Object.keys(body).length > 0) await editRepo(transport, ref, body)
  if (adds.length > 0 || removes.length > 0) {
    const old = await repoTopics(transport, ref)
    const next = [...new Set([...old, ...adds])].filter((topic) => !removes.includes(topic))
    const same = next.length === old.length && next.every((topic) => old.includes(topic))
    if (!same) await setRepoTopics(transport, ref, next)
  }
  return [new Uint8Array(0), new IOResult()]
}

/**
 * `gh repo delete REPO --yes`. A name with no owner is the viewer's, as gh
 * reads it. The current repository is never deleted by default: gh ignores
 * `--yes` there and prompts, so without a terminal it refuses. `--confirm`
 * is gh's deprecated spelling of `--yes`, and it warns the way cobra does.
 */
export async function deleteCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const confirmed = ghBool(fl, 'yes') || ghBool(fl, 'confirm')
  const spec = inv.texts[0]
  if (spec === undefined && confirmed) {
    throw new UsageError(
      'cannot non-interactively delete current repository. Please specify a repository or run interactively',
      1,
    )
  }
  if (!confirmed) throw new UsageError('--yes required when not running interactively', 1)
  const transport = ghTransport(inv.config)
  const named = spec ?? ''
  const ref = ghRepo(inv.config, named.includes('/') ? named : `${await login(transport)}/${named}`)
  await deleteRepo(transport, ref)
  const warning = ghBool(fl, 'confirm')
    ? 'Flag --confirm has been deprecated, use `--yes` instead\n'
    : ''
  return [new Uint8Array(0), new IOResult({ stderr: new TextEncoder().encode(warning) })]
}
