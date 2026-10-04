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

import { IOResult } from '../../../../io/types.ts'
import type { SessionView } from '../../../../ops/types.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { CLIInvocation } from '../../types.ts'
import { headEntries } from './changes.ts'
import {
  AllWithPathsError,
  GitError,
  MissingMessageError,
  NothingToCommitError,
  NoWorkspaceError,
  PartialCommitError,
  UnmergedIndexError,
} from './errors.ts'
import { stageTracked } from './add.ts'
import { commitSummary } from './diff_output.ts'
import { readIndex, updateIndex } from './index_file.ts'
import { rewrite, under } from './io.ts'
import { record } from './reflog.ts'
import { detachHead, readHead, writeRef } from './refs.ts'
import { configBool, repoArgs, type Repo } from './repo.ts'
import { opened } from './session.ts'
import { renderReport } from './status.ts'
import { report } from './summary.ts'
import type { TreeEntry } from './tree.ts'
import type { IndexState } from './types.ts'
import { checkSwitches, fatal, startPoint } from './util.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import { encodeText } from '../../../../shell/bytes.ts'

// git tags the first commit on a branch so the reflog reads
// "commit (initial): ..." rather than plain "commit: ...".
const ROOT_NOTE = ' (initial)'
const DEFAULT_NAME = 'mirage'
const DEFAULT_EMAIL = 'mirage@localhost'
// The environment git reads an identity from. There is no config file behind a
// mount, so these are the only real source.
const AUTHOR_NAME = 'GIT_AUTHOR_NAME'
const AUTHOR_EMAIL = 'GIT_AUTHOR_EMAIL'
const FALLBACK_EMAIL = 'EMAIL'

/** An author string split into the two halves git records separately. */
export interface Identity {
  readonly name: string
  readonly email: string
  /** The `Name <email>` spelling, which is what a reflog line carries. */
  readonly line: string
}

/**
 * Who to record as author and committer.
 *
 * Three sources, in git's own order: `--author` outranks the environment, and
 * the environment outranks the fallback. git reads `GIT_AUTHOR_NAME` and
 * `GIT_AUTHOR_EMAIL`, with `EMAIL` as the fallback address, all pinned against
 * git 2.50.
 *
 * Two deliberate divergences, both because a config file is not reachable from
 * a mount. `user.name`/`user.email` are never consulted, so the environment is
 * the only place a real identity can come from; and where git refuses to commit
 * with no identity at all, mirage records a stated default rather than a guess
 * at the operator's name. The committer is the author here, where git tracks
 * `GIT_COMMITTER_*` separately.
 *
 * Read through the session plane's door rather than the frozen `inv.env`
 * snapshot, so a hidden name reads as unset exactly as it does in the shell.
 */
export function identity(fl: FlagView, session: SessionView | undefined): Identity {
  const author = fl.asStr('author')
  if (author === undefined || author === '') {
    const name = session?.get(AUTHOR_NAME) ?? null
    if (name !== null && name !== '') {
      const email = session?.get(AUTHOR_EMAIL) ?? session?.get(FALLBACK_EMAIL) ?? null
      const address = email !== null && email !== '' ? email : DEFAULT_EMAIL
      return { name, email: address, line: `${name} <${address}>` }
    }
    return {
      name: DEFAULT_NAME,
      email: DEFAULT_EMAIL,
      line: `${DEFAULT_NAME} <${DEFAULT_EMAIL}>`,
    }
  }
  const match = /^(.*?)\s*<([^>]*)>\s*$/.exec(author)
  if (match === null) return { name: author, email: '', line: `${author} <>` }
  return { name: match[1] ?? '', email: match[2] ?? '', line: author }
}

/** The tree entries the index describes, keyed by path. */
function indexTree(state: IndexState): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>()
  for (const [path, entry] of state.entries) {
    out.set(path, { oid: entry.oid, mode: entry.mode.toString(8) })
  }
  return out
}

/**
 * Write the trees the index describes and the commit above them.
 *
 * The tree is built from the index rather than the working tree, which is the
 * whole point of an index: what was staged is what is recorded, however the
 * files have moved on since.
 */
async function buildCommit(
  repo: Repo,
  state: IndexState,
  message: string,
  who: Identity,
  parents: readonly string[],
  when: number,
): Promise<string> {
  // Nested trees are written bottom-up: a directory's entry names the id of the
  // tree below it, so the deepest have to exist first.
  const byDir = new Map<string, { mode: string; path: string; oid: string; type: string }[]>()
  const ensure = (dir: string): { mode: string; path: string; oid: string; type: string }[] => {
    const held = byDir.get(dir)
    if (held !== undefined) return held
    const fresh: { mode: string; path: string; oid: string; type: string }[] = []
    byDir.set(dir, fresh)
    return fresh
  }
  ensure('')
  for (const [path, entry] of [...state.entries].sort(([a], [b]) => compareCodePoints(a, b))) {
    const cut = path.lastIndexOf('/')
    const dir = cut === -1 ? '' : path.slice(0, cut)
    for (let at = dir; at !== '';) {
      ensure(at)
      const up = at.lastIndexOf('/')
      at = up === -1 ? '' : at.slice(0, up)
    }
    ensure(dir).push({
      mode: entry.mode.toString(8),
      path: cut === -1 ? path : path.slice(cut + 1),
      oid: entry.oid,
      type: 'blob',
    })
  }
  // Deepest first, and the root is depth 0 rather than 1: `''.split('/')` is
  // one empty segment, so measuring by segment count alone ties the root with
  // every top-level directory and can write it before its own children.
  const depth = (dir: string): number => (dir === '' ? 0 : dir.split('/').length)
  const written = new Map<string, string>()
  for (const dir of [...byDir.keys()].sort((a, b) => depth(b) - depth(a))) {
    const entries = ensure(dir)
    for (const [child, oid] of written) {
      const cut = child.lastIndexOf('/')
      if ((cut === -1 ? '' : child.slice(0, cut)) !== dir) continue
      entries.push({
        mode: '040000',
        path: cut === -1 ? child : child.slice(cut + 1),
        oid,
        type: 'tree',
      })
    }
    entries.sort((a, b) => compareCodePoints(a.path, b.path))
    written.set(dir, await git.writeTree({ ...repoArgs(repo), tree: entries as never }))
  }
  const tree = written.get('')
  if (tree === undefined) throw new Error('commit: no root tree was written')
  const stamp = { name: who.name, email: who.email, timestamp: when, timezoneOffset: 0 }
  return git.writeCommit({
    ...repoArgs(repo),
    commit: {
      tree,
      parent: [...parents],
      author: stamp,
      committer: stamp,
      message: `${message}\n`,
    },
  })
}

/**
 * Record the index as a new commit on the current branch.
 *
 * The message must come from `-m`: git would otherwise open an editor, which a
 * mount has no way to offer, and inventing a message would put an unreviewed one
 * into history.
 *
 * `-a` restages every tracked path first, as `add -u` would, and the index keeps
 * that staging only once the commit is written. git's `-a` also resolves
 * conflicted paths and records a merge commit from `MERGE_HEAD`; this build
 * writes no merge commits, so an unmerged index is refused with or without `-a`.
 */
export async function commit(inv: CLIInvocation): Promise<CommandFnResult> {
  const doors = inv.doors ?? {}
  const fl = new FlagView(inv.flags)
  try {
    const dispatch = doors.dispatch
    const statPath = doors.statPath
    if (statPath === undefined || dispatch === undefined) {
      throw new NoWorkspaceError()
    }
    const texts = [...inv.texts]
    checkSwitches(inv, texts)
    const staging = fl.asBool('all')
    const named = texts[0]
    if (named !== undefined)
      throw staging ? new AllWithPathsError(named) : new PartialCommitError(named)
    const message = fl.asStr('message')
    if (message === undefined || message === '') throw new MissingMessageError()
    const repo = await opened(fl, doors, true)
    // git locks and rewrites the index before it looks for anything to commit,
    // so a read-only repository refuses an empty commit too.
    await rewrite(dispatch, under(repo.location.gitdir, 'index'))
    const state = await readIndex(repo, dispatch)
    if (state.conflicts.size > 0) throw new UnmergedIndexError()
    const restaged = staging
      ? await stageTracked(repo, dispatch, statPath, state, doors.ns?.links ?? null)
      : null
    const head = await readHead(dispatch, repo.location.gitdir)
    const before = await headEntries(repo)
    const after = indexTree(state)
    const same =
      before !== null &&
      before.size === after.size &&
      [...after].every(([path, entry]) => {
        const held = before.get(path)
        return held?.oid === entry.oid && held.mode === entry.mode
      })
    if (same && !fl.asBool('allow_empty')) {
      throw new NothingToCommitError(
        await renderReport(repo, dispatch, statPath, head, startPoint(fl), doors.ns?.links ?? null),
      )
    }
    const parents =
      before === null ? [] : [await git.resolveRef({ ...repoArgs(repo), ref: 'HEAD' })]
    const who = identity(fl, doors.sessionView)
    const when = Math.floor(Date.now() / 1000)
    const oid = await buildCommit(repo, state, message, who, parents, when)
    if (head.ref !== null) await writeRef(dispatch, repo.location.commondir, head.ref, oid)
    else await detachHead(dispatch, repo.location.gitdir, oid)
    if (restaged !== null) await updateIndex(repo, restaged[0], restaged[1])
    await record(
      dispatch,
      repo.location.gitdir,
      repo.location.commondir,
      head.ref,
      parents[0] ?? null,
      oid,
      who.line,
      when,
      `commit${before === null ? ROOT_NOTE : ''}: ${message.split('\n')[0] ?? ''}`,
    )
    const body = report(
      oid,
      message,
      head.branch,
      await commitSummary(
        repo,
        before ?? new Map(),
        after,
        await configBool(repo, 'core.quotepath', true),
      ),
      repo.abbrev,
      before === null,
    )
    return [fl.asBool('quiet') ? null : encodeText(body), new IOResult()]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}
