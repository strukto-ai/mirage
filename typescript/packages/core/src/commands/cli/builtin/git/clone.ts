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
import { CloneReadOnlyError, GitError, UsageError } from './errors.ts'
import { configuredHeaders, fetchObjects, ignoreFunny } from './fetch.ts'
import { layOut } from './init.ts'
import { readNames, removeTree, statOf, writeFile } from './io.ts'
import { append, entry, IDENTITY, ZERO } from './reflog.ts'
import { DEFAULT_BRANCH } from './constants.ts'
import { BRANCH_PREFIX, detachHead, setHead, TAG_PREFIX, validRefName, writeRef } from './refs.ts'
import { openRepo } from './repo.ts'
import { commitEntries } from './tree.ts'
import { isLocal, openTransport, type Advertisement, type Transport } from './transport.ts'
import type { ReadOnlyRefusal, RepoLocation } from './types.ts'

const ENC = new TextEncoder()

/** The directory git names a clone after when none is given. */
export function defaultDirectory(url: string): string {
  let path = url.replace(/\/+$/, '')
  if (path.endsWith('/.git')) path = path.slice(0, -'/.git'.length).replace(/\/+$/, '')
  if (path.endsWith('.git')) path = path.slice(0, -'.git'.length)
  return path.split(/[/:]/).at(-1) ?? path
}

/** A clone's config, in the order git writes it. */
function config(url: string, remote: string, branch: string | null): string {
  let text =
    '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n' +
    '\tlogallrefupdates = true\n' +
    configSection('remote', remote, [
      ['url', url],
      ['fetch', `+refs/heads/*:refs/remotes/${remote}/*`],
    ])
  if (branch !== null)
    text += configSection('branch', branch, [
      ['remote', remote],
      ['merge', `${BRANCH_PREFIX}${branch}`],
    ])
  return text
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
 * and every tag as a tag, and the remote's HEAD branch is checked out. A failed
 * clone removes what it wrote, and keeps a directory that was already there,
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
  const stored = !local || url.startsWith('/') ? url : `${start.virtual.replace(/\/+$/, '')}/${url}`
  let notes = quiet ? '' : `Cloning into '${name}'...\n`
  try {
    notes += await populate(ctx, transport, target, stored, local && !quiet)
  } catch (err) {
    if (!(err instanceof GitError)) throw err
    const vfs = ctx.vfs
    if (fresh && vfs !== undefined) await removeTree(vfs, target)
    else if (vfs !== undefined)
      for (const entry of await readNames(vfs, target)) {
        const child = entry.replace(/\/+$/, '').split('/').at(-1) ?? ''
        if (child) await removeTree(vfs, target.join(child))
      }
    const refusal = err.prefix === null ? err.message : `${err.prefix}: ${err.message}`
    return [null, new IOResult({ exitCode: err.code, stderr: ENC.encode(`${notes}${refusal}\n`) })]
  }
  return [null, new IOResult({ stderr: ENC.encode(notes) })]
}

/** Lay the clone out, fetch into it and check it out; returns what it prints after `Cloning into`. */
async function populate(
  ctx: Context,
  transport: Transport,
  target: PathSpec,
  url: string,
  local: boolean,
): Promise<string> {
  const fl = new FlagView(ctx.flags)
  const vfs = requireVfs(ctx)
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
  const [wants, funny] = ignoreFunny(
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
  let notes = funny
  // Only what survived is a candidate for the branch to check out: a HEAD
  // naming a refused branch detaches, as git's does.
  const kept = new Set(wants.map((want) => want.remote))
  const adv: Advertisement = {
    refs: new Map([...advertised.refs].filter(([ref]) => kept.has(ref) || ref === 'HEAD')),
    peeled: new Map([...advertised.peeled].filter(([ref]) => kept.has(ref))),
    head: advertised.head !== null && kept.has(advertised.head) ? advertised.head : null,
  }
  const chosen = fl.asStr('branch') ?? null
  const picked = remoteHead(adv, chosen)
  let branch = picked[0]
  const commit = picked[1]
  if (chosen !== null && commit === null)
    throw new GitError(`Remote branch ${chosen} not found in upstream ${remote}`)
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
  const [repo] = await fetchObjects(await openRepo(vfs, location), transport, adv, wants, false)
  for (const want of wants)
    if (want.local !== null) await writeRef(vfs, gitdir, want.local, want.oid)
  const reason = `clone: from ${url}`
  const now = Math.floor(Date.now() / 1000)
  const headOid = adv.head === null ? undefined : adv.refs.get(adv.head)
  if (adv.head !== null && headOid !== undefined) {
    const tracking = `refs/remotes/${remote}/HEAD`
    await writeFile(
      vfs,
      gitdir.join(tracking),
      ENC.encode(`ref: refs/remotes/${remote}/${adv.head.slice(BRANCH_PREFIX.length)}\n`),
    )
    await append(vfs, gitdir, `logs/${tracking}`, entry(ZERO, headOid, IDENTITY, now, reason))
  }
  await writeFile(vfs, gitdir.join('config'), ENC.encode(config(url, remote, branch)))
  if (local) notes += 'done.\n'
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
  if (!fl.asBool('no_checkout'))
    await switchTo(repo, vfs, new Map(), await commitEntries(repo, commit))
  return notes
}

/** clone's refusal by a read-only mount, at the work tree it could not make. */
export const cloneReadOnly: ReadOnlyRefusal = (texts) =>
  new CloneReadOnlyError(texts[1] ?? defaultDirectory(texts[0] ?? ''))
