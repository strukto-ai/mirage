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

import git from 'isomorphic-git'

import type { MountRoot, StatPath } from '../../../../ops/types.ts'
import type { FlagView } from '../../../spec/types.ts'
import { discover } from './discover.ts'
import { NoWorkspaceError } from './errors.ts'
import { abbrevLength, type CommitFacts } from './format.ts'
import { gitFs } from './fs.ts'
import { readNames, readRange, under } from './io.ts'
import { basename } from './path.ts'
import { startPoint } from './util.ts'
import type { Dispatch, RepoLocation } from './types.ts'

const PACK_DIR = 'objects/pack'
const IDX_SUFFIX = '.idx'
// A v2 pack index is a 8-byte header then 256 fanout entries; the last one is
// the object count, so the total is four bytes at a fixed offset.
const FANOUT_END = 8 + 256 * 4

/**
 * A repository living in a mount, opened for reading.
 *
 * `fs` is the whole bridge: isomorphic-git reaches every byte through it, so its
 * own algorithms (history walk, tree diff, three-way merge) run against a mount
 * without ever learning that one exists. Nothing here is loaded eagerly, which
 * is also what git does.
 *
 * Objects come from the common directory and refs from both: a linked worktree
 * shares the object database and the branches of the repository it was cut from,
 * and owns only HEAD and whatever refs are per-checkout.
 */
export interface Repo {
  readonly fs: ReturnType<typeof gitFs>
  readonly dispatch: Dispatch
  readonly location: RepoLocation
  /** How many hex digits this repository abbreviates an id to. */
  readonly abbrev: number
}

/** The argument bag every isomorphic-git call in this package shares. */
export function repoArgs(repo: Repo): { fs: never; dir: string; gitdir: string } {
  return {
    fs: repo.fs as never,
    dir: repo.location.worktree,
    gitdir: repo.location.commondir,
  }
}

/**
 * How many objects the repository's packs hold, for the id abbreviation.
 *
 * Read off each pack index, which states its own count in its fanout table, so
 * this costs one small ranged read per pack. Loose objects are deliberately not
 * counted: git's own estimate ignores them, and matching that is what makes an
 * abbreviated id agree with real git.
 */
async function packedCount(dispatch: Dispatch, commondir: string): Promise<number> {
  const root = under(commondir, PACK_DIR)
  let total = 0
  for (const entry of await readNames(dispatch, root)) {
    const name = basename(entry)
    if (!name.endsWith(IDX_SUFFIX)) continue
    const head = await readRange(dispatch, under(root, name), FANOUT_END - 4, 4)
    if (head.byteLength < 4) continue
    total += new DataView(head.buffer, head.byteOffset, 4).getUint32(0, false)
  }
  return total
}

/**
 * Open a repository living in a mount.
 *
 * @param dispatch workspace op dispatcher
 * @param location the discovered repository
 */
async function openRepo(dispatch: Dispatch, location: RepoLocation): Promise<Repo> {
  return {
    fs: gitFs(dispatch),
    dispatch,
    location,
    abbrev: abbrevLength(await packedCount(dispatch, location.commondir)),
  }
}

/**
 * Discover and open the repository a verb was invoked against.
 *
 * Every verb starts the same way: honor `-C`, walk up to the mount root looking
 * for a `.git`, then open the object database across the dispatcher. Kept in one
 * place so a new verb inherits the discovery rules rather than restating them.
 *
 * @param fl the leaf's flag bag, read for `-C`
 * @param statPath dispatcher-backed stat, both channels
 * @param mountRoot the mount prefix serving a path
 * @param dispatch workspace op dispatcher
 */
export async function opened(
  fl: FlagView,
  statPath: StatPath | undefined,
  mountRoot: MountRoot | undefined,
  dispatch: Dispatch | undefined,
): Promise<Repo> {
  if (statPath === undefined || mountRoot === undefined || dispatch === undefined) {
    throw new NoWorkspaceError()
  }
  const location = await discover(dispatch, statPath, mountRoot, startPoint(fl))
  return openRepo(dispatch, location)
}

/**
 * One commit as the renderers want it.
 *
 * isomorphic-git reports the timezone the way `Date.getTimezoneOffset()` does,
 * negated minutes east of UTC, so `+0530` arrives as `-330`. git prints the
 * other sign, and this is the one place the two conventions meet.
 */
export async function commitFacts(repo: Repo, oid: string): Promise<CommitFacts> {
  const { commit } = await git.readCommit({ ...repoArgs(repo), oid })
  return {
    oid,
    tree: commit.tree,
    message: commit.message,
    authorName: commit.author.name,
    authorEmail: commit.author.email,
    authorTime: commit.author.timestamp,
    authorTimezoneMinutes: -commit.author.timezoneOffset,
    committerName: commit.committer.name,
    committerEmail: commit.committer.email,
    committerTime: commit.committer.timestamp,
    committerTimezoneMinutes: -commit.committer.timezoneOffset,
    parents: commit.parent,
  }
}
