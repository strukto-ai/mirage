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

import type { NOOPAccessor } from '../../../../accessor/base.ts'
import { IOResult } from '../../../../io/types.ts'
import type { PathSpec } from '../../../../types.ts'
import type { Files } from '../../../../workspace/files.ts'
import { fnmatch } from '../../../../utils/fnmatch.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { configKey } from './config.ts'
import { dateClock } from './dates.ts'
import { isBare } from './discover.ts'
import { GitError, MissingRepositoryError, UsageError } from './errors.ts'
import { UNREACHABLE, configuredHeaders } from './fetch.ts'
import { configLines, type ConfigLine } from './fs.ts'
import { rewriteUrl, urlRules } from './inspect.ts'
import { readOptional } from './io.ts'
import { needsObject } from './ref_fields.ts'
import { ValueTable, sortRefs } from './ref_format.ts'
import { refListing, refObject, sortKeys } from './ref_list.ts'
import { readHead } from './refs.ts'
import type { Repo } from './repo.ts'
import { inside, opened } from './session.ts'
import { PEELED, displayUrl, openTransport, type Advertisement } from './transport.ts'
import {
  RefKind,
  type RefContext,
  type RefItem,
  type RefSortKey,
  type RepoLocation,
} from './types.ts'
import { optionOperand, requireVfs, startPoint, verbUsage } from './util.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const NOTHING_CONFIGURED = 'No remote configured to list refs from.'
const HEADS_NAMESPACE = 'refs/heads/'
const TAGS_NAMESPACE = 'refs/tags/'
const REFS_NAMESPACE = 'refs/'
const HEAD_NAME = 'HEAD'
const HELP_SWITCH = '-h'
const NOTHING_LISTED = 2

type Row = readonly [string, string]

/** The repository's config lines, the command line's after them. */
async function configOf(repo: RepoLocation | null, vfs: Files): Promise<ConfigLine[]> {
  if (repo === null) return []
  const data = await readOptional(vfs, repo.commondir.join('config'))
  const lines = await configLines(DEC.decode(data ?? new Uint8Array()))
  const typed = (repo.overrides ?? []).map(
    ([name, value]) => ({ path: configKey(name), value: value ?? 'true' }) as ConfigLine,
  )
  return [...lines, ...typed]
}

/** The remote a line naming none lists: the branch's, else the one remote defined, else `origin`. */
function defaultRemote(cfg: readonly ConfigLine[], branch: string | null): string {
  if (branch !== null) {
    const key = configKey(`branch.${branch}.remote`)
    const named = cfg.filter((line) => line.path === key).at(-1)
    if (named !== undefined) return named.value ?? ''
  }
  const names = new Set<string>()
  for (const line of cfg) {
    if (!line.path.startsWith('remote.')) continue
    names.add(line.path.slice('remote.'.length, line.path.lastIndexOf('.')))
  }
  return names.size === 1 ? ([...names][0] ?? 'origin') : 'origin'
}

/** Every advertised name and id, a tag's peeled row after it. */
function rowsOf(adv: Advertisement): Row[] {
  const rows: Row[] = []
  for (const [name, oid] of adv.refs) {
    rows.push([name, oid])
    const peeled = adv.peeled.get(name)
    if (peeled !== undefined) rows.push([`${name}${PEELED}`, peeled])
  }
  return rows
}

/** Whether the options keep a name. A pattern matches the name's tail at a slash, `*` crossing slashes. */
function listed(name: string, fl: FlagView, patterns: readonly string[]): boolean {
  if (fl.asBool('refs') && (!name.startsWith(REFS_NAMESPACE) || name.endsWith(PEELED))) return false
  const heads = fl.asBool('heads') || fl.asBool('branches')
  const tags = fl.asBool('tags')
  if (
    (heads || tags) &&
    !((heads && name.startsWith(HEADS_NAMESPACE)) || (tags && name.startsWith(TAGS_NAMESPACE)))
  ) {
    return false
  }
  return patterns.length === 0 || patterns.some((pattern) => fnmatch(`/${name}`, `*/${pattern}`))
}

/**
 * The rows in the order the `--sort` keys give. A key reading an object needs
 * that object here, where a remote's ids are usually not.
 */
async function inOrder(
  ctx: Context,
  fl: FlagView,
  rows: readonly Row[],
  keys: readonly RefSortKey[],
  inRepo: boolean,
): Promise<Row[]> {
  const fields = keys.map((key) => key.field)
  const reading = fields.filter((field) => needsObject(field))
  const first = reading[0]
  if (first !== undefined && !inRepo) {
    throw new GitError(
      `not a git repository, but the field '${first.name}' requires access to object data`,
    )
  }
  let refCtx: RefContext = {
    known: new Set(),
    strict: true,
    head: null,
    headDescription: '',
    abbrev: 7,
    abbreviations: new Map(),
    mailmap: [],
    date: dateClock(ctx.env),
    suffixes: [],
  }
  let repo: Repo | null = null
  if (inRepo) {
    repo = await opened(ctx, fl)
    refCtx = (await refListing(repo, fields, () => false, null, dateClock(ctx.env)))[1]
  }
  const items: RefItem[] = []
  for (const [name, oid] of rows) {
    let obj = null
    if (first !== undefined && repo !== null) {
      try {
        obj = await refObject(repo, oid)
      } catch (err) {
        if (err instanceof GitError) throw err
        throw new GitError(`missing object ${oid} for ${name}`)
      }
    }
    items.push({
      name,
      oid,
      kind: RefKind.OTHER,
      symref: null,
      obj,
      peeled: null,
      upstream: null,
      worktree: '',
    })
  }
  const done = sortRefs(items, keys, new ValueTable(fields, refCtx), refCtx, false)
  return done.map((item): Row => [item.name, item.oid])
}

/** List the refs another repository publishes. */
export async function lsRemote(
  _accessor: NOOPAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const vfs = requireVfs(ctx)
  const argv = ctx.argv ?? []
  if (argv.at(-2) === 'ls-remote' && argv.at(-1) === HELP_SWITCH) {
    throw new UsageError(verbUsage(ctx), '')
  }
  if (optionOperand(ctx, texts) !== null) throw new UsageError('', verbUsage(ctx))
  const keys = sortKeys(fl, [])
  const location = await inside(ctx, fl)
  const cfg = await configOf(location, vfs)
  const named = texts[0] ?? null
  let remote = named
  if (remote === null) {
    const branch = location === null ? null : (await readHead(vfs, location.gitdir)).branch
    remote = defaultRemote(cfg, branch)
  }
  const key = `remote.${remote}.url`
  const urls = cfg.filter((line) => line.path === configKey(key)).map((line) => line.value ?? '')
  if (named === null && urls.length === 0) throw new GitError(NOTHING_CONFIGURED)
  const url = rewriteUrl(urls[0] ?? remote, urlRules(cfg)[0])
  if (fl.asBool('get_url')) return [ENC.encode(`${url}\n`), new IOResult()]
  let start = startPoint(fl)
  if (location !== null) start = (await isBare(vfs, location)) ? location.gitdir : location.worktree
  let adv: Advertisement
  try {
    const repo = location === null ? null : await opened(ctx, fl)
    const transport = await openTransport(ctx, url, start, await configuredHeaders(ctx, repo))
    adv = await transport.advertise()
  } catch (err) {
    if (err instanceof MissingRepositoryError) {
      throw new GitError(`'${url}' does not appear to be a git repository\n${UNREACHABLE}`)
    }
    throw err
  }
  const patterns = texts.slice(1)
  let rows = rowsOf(adv).filter(([name]) => listed(name, fl, patterns))
  if (keys !== null) rows = await inOrder(ctx, fl, rows, keys, location !== null)
  const targets = new Map(adv.symrefs ?? [])
  if (adv.head !== null && !targets.has(HEAD_NAME)) targets.set(HEAD_NAME, adv.head)
  const showSymrefs = fl.asBool('symref')
  let out = ''
  for (const [name, oid] of rows) {
    const target = targets.get(name)
    if (showSymrefs && target !== undefined) out += `ref: ${target}\t${name}\n`
    out += `${oid}\t${name}\n`
  }
  const told = named === null && !fl.asBool('quiet')
  const exitCode = fl.asBool('exit_code') && rows.length === 0 ? NOTHING_LISTED : 0
  return [
    out === '' ? null : ENC.encode(out),
    new IOResult({
      exitCode,
      ...(told ? { stderr: ENC.encode(`From ${displayUrl(url)}\n`) } : {}),
    }),
  ]
}
