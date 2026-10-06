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

import { startPoint, checkSwitches, configSection, fatal, verbUsage } from './util.ts'
import { PathSpec, FileType } from '../../../../types.ts'

import { IOResult } from '../../../../io/types.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { CLIDoors, CLIInvocation } from '../../types.ts'
import { DETACHED_ADVICE, switchTo } from './checkout.ts'
import { CloneReadOnlyError, GitError, NoWorkspaceError, UsageError } from './errors.ts'
import { configuredHeaders, fetchObjects, HEADS, ignoreFunny, TAGS } from './fetch.ts'
import { layOut } from './init.ts'
import { readNames, removeTree, writeFile } from './io.ts'
import { append, entry, IDENTITY, ZERO } from './reflog.ts'
import { detachHead, setHead, validRefName, writeRef } from './refs.ts'
import { openRepo } from './repo.ts'
import { commitEntries } from './tree.ts'
import { isLocal, openTransport, type Advertisement, type Transport } from './transport.ts'
import type { ReadOnlyRefusal, RepoLocation } from './types.ts'

const ENC = new TextEncoder()
const DEFAULT_BRANCH = 'master'

/** The directory git names a clone after, as `guess_dir_name` does. */
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
      ['merge', `${HEADS}${branch}`],
    ])
  return text
}

/** The branch a clone checks out and the commit it starts at. */
export function remoteHead(
  adv: Advertisement,
  chosen: string | null,
): [string | null, string | null] {
  if (chosen !== null) {
    for (const ref of [`${HEADS}${chosen}`, `${TAGS}${chosen}`]) {
      const oid = adv.refs.get(ref)
      if (oid !== undefined)
        return [ref.startsWith(HEADS) ? chosen : null, adv.peeled.get(ref) ?? oid]
    }
    return [chosen, null]
  }
  if (adv.head !== null) {
    const oid = adv.refs.get(adv.head)
    if (oid !== undefined) return [adv.head.slice(HEADS.length), oid]
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
 * empty, as git does.
 */
export async function clone(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const doors = inv.doors ?? {}
  const [url, named] = inv.texts
  try {
    checkSwitches(inv, inv.texts)
    if (url === undefined) {
      throw new UsageError(
        '',
        `fatal: You must specify a repository to clone.\n\n${verbUsage(inv)}`,
      )
    }
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
  const name = named ?? defaultDirectory(url)
  const quiet = fl.asBool('quiet')
  let target: PathSpec
  let fresh: boolean
  let transport: Transport
  let start: PathSpec
  try {
    const { dispatch, statPath } = doors
    if (dispatch === undefined || statPath === undefined) throw new NoWorkspaceError()
    start = startPoint(fl)
    target = PathSpec.fromStrPath(name, undefined, start)
    const info = await statPath(target)
    if (
      info !== null &&
      (info.type !== FileType.DIRECTORY || (await readNames(dispatch, target)).length)
    )
      throw new GitError(`destination path '${name}' already exists and is not an empty directory.`)
    fresh = info === null
    transport = await openTransport(url, start, doors, await configuredHeaders(inv, null))
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
  const local = isLocal(url)
  // git records a local path the way absolute_pathdup spells it: the directory
  // it ran in and the path as typed, not normalized.
  const stored = !local || url.startsWith('/') ? url : `${start.virtual.replace(/\/+$/, '')}/${url}`
  let notes = quiet ? '' : `Cloning into '${name}'...\n`
  try {
    notes += await populate(inv, doors, transport, target, stored, local && !quiet)
  } catch (err) {
    if (!(err instanceof GitError)) throw err
    const { dispatch } = doors
    const links = doors.ns?.links ?? null
    const mounts = doors.ns?.mounts ?? null
    if (fresh && dispatch !== undefined) await removeTree(dispatch, target, links, mounts)
    else if (dispatch !== undefined)
      for (const entry of await readNames(dispatch, target)) {
        const child = entry.replace(/\/+$/, '').split('/').at(-1) ?? ''
        if (child) await removeTree(dispatch, target.join(child), links, mounts)
      }
    const refusal = err.prefix === null ? err.message : `${err.prefix}: ${err.message}`
    return [null, new IOResult({ exitCode: err.code, stderr: ENC.encode(`${notes}${refusal}\n`) })]
  }
  return [null, new IOResult({ stderr: ENC.encode(notes) })]
}

/** Lay the clone out, fetch into it and check it out; returns what it prints after `Cloning into`. */
async function populate(
  inv: CLIInvocation,
  doors: CLIDoors,
  transport: Transport,
  target: PathSpec,
  url: string,
  local: boolean,
): Promise<string> {
  const fl = new FlagView(inv.flags)
  const { dispatch, statPath } = doors
  if (dispatch === undefined || statPath === undefined) throw new NoWorkspaceError()
  const mounts = doors.ns?.mounts ?? null
  const gitdir = target.join('.git')
  const remote = fl.asStr('origin') ?? 'origin'
  if (!validRefName(`refs/remotes/${remote}/test`))
    throw new GitError(`'${remote}' is not a valid remote name`)
  await layOut(dispatch, gitdir, DEFAULT_BRANCH, '')
  const advertised = await transport.advertise()
  const location: RepoLocation = {
    gitdir,
    commondir: gitdir,
    worktree: target,
    mountRoot: PathSpec.fromStrPath(mounts?.rootOf(target.virtual) ?? '/', undefined, '/'),
  }
  const [wants, funny] = ignoreFunny(
    [...advertised.refs]
      .filter(([ref]) => ref.startsWith(HEADS) || ref.startsWith(TAGS))
      .map(([ref, oid]) => ({
        remote: ref,
        oid,
        local: ref.startsWith(HEADS) ? `refs/remotes/${remote}/${ref.slice(HEADS.length)}` : ref,
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
  if (!advertised.refs.size) {
    notes += 'warning: You appear to have cloned an empty repository.\n'
    const head = advertised.head
    branch = (
      head?.startsWith(HEADS) && validRefName(head) ? head : `${HEADS}${DEFAULT_BRANCH}`
    ).slice(HEADS.length)
  }
  const [repo] = await fetchObjects(
    await openRepo(dispatch, location),
    transport,
    adv,
    wants,
    false,
  )
  for (const want of wants)
    if (want.local !== null) await writeRef(dispatch, gitdir, want.local, want.oid)
  const reason = `clone: from ${url}`
  const now = Math.floor(Date.now() / 1000)
  const headOid = adv.head === null ? undefined : adv.refs.get(adv.head)
  if (adv.head !== null && headOid !== undefined) {
    const tracking = `refs/remotes/${remote}/HEAD`
    await writeFile(
      dispatch,
      gitdir.join(tracking),
      ENC.encode(`ref: refs/remotes/${remote}/${adv.head.slice(HEADS.length)}\n`),
    )
    await append(dispatch, gitdir, `logs/${tracking}`, entry(ZERO, headOid, IDENTITY, now, reason))
  }
  await writeFile(dispatch, gitdir.join('config'), ENC.encode(config(url, remote, branch)))
  if (local) notes += 'done.\n'
  if (commit === null) {
    await setHead(dispatch, gitdir, `${HEADS}${branch ?? DEFAULT_BRANCH}`)
    return notes
  }
  const line = entry(ZERO, commit, IDENTITY, now, reason)
  if (branch !== null) {
    await writeRef(dispatch, gitdir, `${HEADS}${branch}`, commit)
    await setHead(dispatch, gitdir, `${HEADS}${branch}`)
    await append(dispatch, gitdir, `logs/${HEADS}${branch}`, line)
  } else {
    await detachHead(dispatch, gitdir, commit)
    notes += `Note: switching to '${commit}'.\n\n${DETACHED_ADVICE}\n`
  }
  await append(dispatch, gitdir, 'logs/HEAD', line)
  if (!fl.asBool('no_checkout'))
    await switchTo(
      repo,
      dispatch,
      statPath,
      new Map(),
      await commitEntries(repo, commit),
      doors.ns?.links ?? null,
      mounts,
    )
  return notes
}

/** clone's refusal by a read-only mount, at the work tree it could not make. */
export const cloneReadOnly: ReadOnlyRefusal = (inv) =>
  new CloneReadOnlyError(inv.texts[1] ?? defaultDirectory(inv.texts[0] ?? ''))
