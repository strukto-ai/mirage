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
import { startPoint, checkSwitches, configSection, verbUsage, requireVfs } from './util.ts'
import { PathSpec, FileType } from '../../../../types.ts'

import { IOResult } from '../../../../io/types.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { DETACHED_ADVICE, switchTo } from './checkout.ts'
import {
  CloneCheckoutError,
  CloneReadOnlyError,
  EmptyTreeNameError,
  GitError,
  InvalidPathError,
  UsageError,
} from './errors.ts'
import { configuredHeaders, fetchObjects, ignoreFunny, wanted } from './fetch.ts'
import { layOut } from './init.ts'
import { readNames, removeTree, statOf, writeFile } from './io.ts'
import { append, entry, IDENTITY, ZERO } from './reflog.ts'
import { DEFAULT_BRANCH } from './constants.ts'
import { BRANCH_PREFIX, detachHead, setHead, TAG_PREFIX, validRefName, writeRef } from './refs.ts'
import { openRepo } from './repo.ts'
import { commitEntries } from './tree.ts'
import {
  checkDepth,
  isLocal,
  openTransport,
  transportDepth,
  type Advertisement,
  type Transport,
} from './transport.ts'
import type { ReadOnlyRefusal, RepoLocation } from './types.ts'
import { systemNow } from '../../../../utils/clock.ts'
import { SYSTEM_IDS } from '../../../../utils/ids.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import { rstripSlash } from '../../../../utils/slash.ts'

const ENC = new TextEncoder()
const LOCAL_DEPTH_WARNING = 'warning: --depth is ignored in local clones; use file:// instead.\n'

/** The directory git names a clone after when none is given. */
export function defaultDirectory(url: string): string {
  let path = rstripSlash(url)
  if (path.endsWith('/.git')) path = rstripSlash(path.slice(0, -'/.git'.length))
  if (path.endsWith('.git')) path = path.slice(0, -'.git'.length)
  return path.split(/[/:]/).at(-1) ?? path
}

/**
 * A clone's config, in the order git writes it. `single` is the one ref a
 * single-branch clone takes, which its fetch refspec names, none for a detached
 * HEAD; null fetches every branch.
 */
function config(
  url: string,
  remote: string,
  branch: string | null,
  single: { readonly remote: string; readonly local: string | null } | null,
): string {
  const fields: [string, string][] = [['url', url]]
  if (single === null) fields.push(['fetch', `+refs/heads/*:refs/remotes/${remote}/*`])
  else if (single.local !== null) fields.push(['fetch', `+${single.remote}:${single.local}`])
  let text =
    '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n' +
    '\tlogallrefupdates = true\n' +
    configSection('remote', remote, fields)
  if (branch !== null)
    text += configSection('branch', branch, [
      ['remote', remote],
      ['merge', `${BRANCH_PREFIX}${branch}`],
    ])
  return text
}

/**
 * The branch a remote's detached HEAD stands for, as git guesses it: a remote
 * that names no symbolic HEAD is read as the branch pointing where HEAD points,
 * the default branch when it does, else the first such branch by name; none
 * leaves HEAD detached (git 2.47.3). `kept` is the refs the clone takes.
 */
export function guessedHead(adv: Advertisement, kept: ReadonlySet<string>): string | null {
  const oid = adv.refs.get('HEAD')
  const branches = [...kept].filter((ref) => ref.startsWith(BRANCH_PREFIX)).sort(compareCodePoints)
  return (
    [`${BRANCH_PREFIX}${DEFAULT_BRANCH}`, ...branches].find(
      (ref) => oid !== undefined && kept.has(ref) && adv.refs.get(ref) === oid,
    ) ?? null
  )
}

/** The branch a clone checks out and the commit it starts at. */
export function remoteHead(
  adv: Advertisement,
  chosen: string | null,
): [string | null, string | null] {
  if (chosen !== null) {
    for (const ref of [`${BRANCH_PREFIX}${chosen}`, `${TAG_PREFIX}${chosen}`]) {
      const oid = adv.refs.get(ref)
      if (oid !== undefined)
        return [ref.startsWith(BRANCH_PREFIX) ? chosen : null, adv.peeled.get(ref) ?? oid]
    }
    return [chosen, null]
  }
  if (adv.head !== null) {
    const oid = adv.refs.get(adv.head)
    if (oid !== undefined) return [adv.head.slice(BRANCH_PREFIX.length), oid]
  }
  return [null, adv.refs.get('HEAD') ?? null]
}

/**
 * Clone a repository into a new directory.
 *
 * A path or `file://` URL is a repository inside the workspace, an `https://`
 * one is fetched over smart HTTP. Every branch lands as a remote-tracking ref
 * and every tag as a tag, and the remote's HEAD branch is checked out.
 * `--single-branch` takes only the branch or tag it checks out, and the tags
 * that point into its history; `--depth` implies it and cuts the history that
 * many commits deep, except from a plain path, which git warns it ignores the
 * depth for. A failed clone removes what it wrote, and keeps a directory that was already there,
 * empty, as git does. `credentials` is the Authorization `gh repo clone` sends,
 * scoped to the URL's origin as userinfo is and never written to the clone's
 * config.
 */
export async function clone(
  _accessor: NOOPAccessor,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
  credentials: Readonly<Record<string, string>> = {},
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const [url, named] = texts
  checkSwitches(ctx, texts)
  if (url === undefined) {
    throw new UsageError('', `fatal: You must specify a repository to clone.\n\n${verbUsage(ctx)}`)
  }
  if (texts.length > 2) throw new UsageError('', `fatal: Too many arguments.\n\n${verbUsage(ctx)}`)
  const name = named ?? defaultDirectory(url)
  const typed = fl.asStr('depth') ?? null
  if (typed !== null) checkDepth(typed)
  const quiet = fl.asBool('quiet')
  const vfs = requireVfs(ctx)
  const start = startPoint(fl)
  const target = PathSpec.fromStrPath(name, undefined, start)
  const info = await statOf(vfs, target)
  if (info !== null && (info.type !== FileType.DIRECTORY || (await readNames(vfs, target)).length))
    throw new GitError(`destination path '${name}' already exists and is not an empty directory.`)
  const fresh = info === null
  const transport = await openTransport(
    ctx,
    url,
    start,
    await configuredHeaders(ctx, null),
    credentials,
  )
  const local = isLocal(url)
  // git records a local path as the directory it ran in joined to the path as
  // typed, not normalized.
  const stored = !local || url.startsWith('/') ? url : `${rstripSlash(start.virtual)}/${url}`
  let notes = quiet ? '' : `Cloning into '${name}'...\n`
  try {
    notes += await populate(ctx, transport, target, stored, local, typed)
  } catch (err) {
    // A refused checkout leaves the clone behind, as git does; any other
    // failure takes back what the clone wrote, mirage's own refusals (its
    // memory limit) included, as git cleans up on any failure.
    if (!(err instanceof CloneCheckoutError)) {
      if (fresh) await removeTree(vfs, target)
      else
        for (const entry of await readNames(vfs, target)) {
          const child = rstripSlash(entry).split('/').at(-1) ?? ''
          if (child) await removeTree(vfs, target.join(child))
        }
    }
    if (!(err instanceof GitError)) throw err
    const refusal = err.prefix === null ? err.message : `${err.prefix}: ${err.message}`
    return [
      null,
      new IOResult({ exitCode: err.exitCode, stderr: ENC.encode(`${notes}${refusal}\n`) }),
    ]
  }
  return [null, new IOResult({ stderr: ENC.encode(notes) })]
}

/**
 * Lay the clone out, fetch into it and check it out; returns what it prints
 * after `Cloning into`. `local` is whether the remote is a plain path, which
 * git copies whole whatever the depth, and prints `done.` after; `typed` is
 * `--depth` as typed, past `checkDepth`, null for the whole history.
 */
async function populate(
  ctx: Context,
  transport: Transport,
  target: PathSpec,
  url: string,
  local: boolean,
  typed: string | null,
): Promise<string> {
  const fl = new FlagView(ctx.flags)
  const vfs = requireVfs(ctx)
  let depth: number | null = null
  let notes = ''
  if (typed !== null && local) notes = LOCAL_DEPTH_WARNING
  else if (typed !== null) depth = transportDepth(typed)
  let single = typed !== null
  for (const [key] of fl.occurrences('single_branch', 'no_single_branch'))
    single = key === 'single_branch'
  const gitdir = target.join('.git')
  const remote = fl.asStr('origin', 'origin')
  if (!validRefName(`refs/remotes/${remote}/test`))
    throw new GitError(`'${remote}' is not a valid remote name`)
  await layOut(vfs, gitdir, DEFAULT_BRANCH, '')
  const advertised = await transport.advertise()
  const location: RepoLocation = {
    gitdir,
    commondir: gitdir,
    worktree: target,
    mountRoot: PathSpec.fromStrPath(vfs.mountOf(target) ?? '/', undefined, '/'),
  }
  const [survivors, funny] = ignoreFunny(
    [...advertised.refs]
      .filter(([ref]) => ref.startsWith(BRANCH_PREFIX) || ref.startsWith(TAG_PREFIX))
      .map(([ref, oid]) => ({
        remote: ref,
        oid,
        local: ref.startsWith(BRANCH_PREFIX)
          ? `refs/remotes/${remote}/${ref.slice(BRANCH_PREFIX.length)}`
          : ref,
        force: false,
        merge: false,
        listed: true,
      })),
  )
  notes += funny
  let wants = survivors
  // Only what survived is a candidate for the branch to check out: a HEAD
  // naming a refused branch detaches, as git's does.
  const kept = new Set(wants.map((want) => want.remote))
  const adv: Advertisement = {
    refs: new Map([...advertised.refs].filter(([ref]) => kept.has(ref) || ref === 'HEAD')),
    peeled: new Map([...advertised.peeled].filter(([ref]) => kept.has(ref))),
    head:
      advertised.head === null
        ? guessedHead(advertised, kept)
        : kept.has(advertised.head)
          ? advertised.head
          : null,
  }
  const chosen = fl.asStr('branch') ?? null
  const picked = remoteHead(adv, chosen)
  let branch = picked[0]
  const commit = picked[1]
  if (chosen !== null && commit === null)
    throw new GitError(`Remote branch ${chosen} not found in upstream ${remote}`)
  const taken =
    branch !== null
      ? `${BRANCH_PREFIX}${branch}`
      : chosen !== null
        ? `${TAG_PREFIX}${chosen}`
        : null
  // A detached HEAD no branch stands for is taken alone, into no ref, and no
  // fetch refspec records it, as git's single-branch clone.
  const narrowed =
    wants.find((want) => want.remote === taken) ??
    (commit !== null ? wanted('HEAD', commit, null) : null)
  if (single && narrowed !== null) wants = [narrowed]
  if (!advertised.refs.size) notes += 'warning: You appear to have cloned an empty repository.\n'
  // No HEAD to start from, in an empty remote or one whose HEAD names a branch
  // it lacks: the clone is born on the branch that HEAD names, as git's unborn
  // advertisement leaves it, or on the default one.
  if (branch === null && commit === null) {
    const head = advertised.head
    branch = (
      head?.startsWith(BRANCH_PREFIX) && validRefName(head)
        ? head
        : `${BRANCH_PREFIX}${DEFAULT_BRANCH}`
    ).slice(BRANCH_PREFIX.length)
  }
  const one = single ? narrowed : null
  const [repo, received] = await fetchObjects(
    await openRepo(vfs, location),
    transport,
    adv,
    wants,
    one !== null,
    ctx.ids ?? SYSTEM_IDS,
    depth,
  )
  for (const want of received)
    if (want.local !== null) await writeRef(vfs, gitdir, want.local, want.oid)
  const reason = `clone: from ${url}`
  const now = Math.floor(systemNow())
  const fetched = new Set(received.map((want) => want.remote))
  const headOid = adv.head === null ? undefined : adv.refs.get(adv.head)
  if (adv.head !== null && headOid !== undefined && fetched.has(adv.head)) {
    const tracking = `refs/remotes/${remote}/HEAD`
    await writeFile(
      vfs,
      gitdir.join(tracking),
      ENC.encode(`ref: refs/remotes/${remote}/${adv.head.slice(BRANCH_PREFIX.length)}\n`),
    )
    await append(vfs, gitdir, `logs/${tracking}`, entry(ZERO, headOid, IDENTITY, now, reason))
  }
  await writeFile(vfs, gitdir.join('config'), ENC.encode(config(url, remote, branch, one)))
  if (local && !fl.asBool('quiet')) notes += 'done.\n'
  if (commit === null) {
    if (advertised.refs.size && !fl.asBool('no_checkout'))
      notes += 'warning: remote HEAD refers to nonexistent ref, unable to checkout\n'
    await setHead(vfs, gitdir, `${BRANCH_PREFIX}${branch ?? DEFAULT_BRANCH}`)
    return notes
  }
  const line = entry(ZERO, commit, IDENTITY, now, reason)
  if (branch !== null) {
    await writeRef(vfs, gitdir, `${BRANCH_PREFIX}${branch}`, commit)
    await setHead(vfs, gitdir, `${BRANCH_PREFIX}${branch}`)
    await append(vfs, gitdir, `logs/${BRANCH_PREFIX}${branch}`, line)
  } else {
    await detachHead(vfs, gitdir, commit)
    notes += `Note: switching to '${commit}'.\n\n${DETACHED_ADVICE}\n`
  }
  await append(vfs, gitdir, 'logs/HEAD', line)
  if (!fl.asBool('no_checkout')) {
    try {
      await switchTo(repo, vfs, new Map(), await commitEntries(repo, commit))
    } catch (err) {
      if (err instanceof InvalidPathError || err instanceof EmptyTreeNameError)
        throw new CloneCheckoutError(notes, err)
      throw err
    }
  }
  return notes
}

/** clone's refusal by a read-only mount, at the work tree it could not make. */
export const cloneReadOnly: ReadOnlyRefusal = (texts) =>
  new CloneReadOnlyError(texts[1] ?? defaultDirectory(texts[0] ?? ''))
