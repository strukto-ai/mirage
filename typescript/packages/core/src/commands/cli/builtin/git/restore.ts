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
import { FileType } from '../../../../types.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/types.ts'
import type { CLIInvocation } from '../../types.ts'
import { headEntries } from './changes.ts'
import { GITLINK_MODE, HEAD } from './constants.ts'
import {
  GitError,
  NoRestorePathsError,
  NoWorkspaceError,
  UnknownPathspecError,
  UnknownSwitchError,
  UnmergedPathError,
  UnreadableTreeError,
  UnresolvableSourceError,
} from './errors.ts'
import { readIndex, updateIndex, type StagedEntry } from './index_file.ts'
import {
  blockingAncestor,
  dropGitlink,
  keepGitlink,
  refuseReplacedMounts,
  removeEmptyParents,
  removeFile,
  removeTree,
  restoreEntry,
  under,
} from './io.ts'
import { matched, repoRelative, under as inside } from './pathspec.ts'
import { opened, repoArgs, type Repo } from './repo.ts'
import { restored } from './reset.ts'
import { COMMIT, TREE, resolveObject, unwrapped } from './revparse.ts'
import { commitEntries, treeEntries, type TreeEntry } from './tree.ts'
import type { GitObject, IndexEntry } from './types.ts'
import { checkOperands, escaped, fatal, startPoint, switches } from './util.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'

/** The parsed shape of a `git restore` invocation. */
interface RestoreFlags {
  /** `--staged`, put the index back. */
  readonly staged: boolean
  /**
   * `--worktree`, put the working tree back. The default when `--staged` is
   * absent, which is git's rule.
   */
  readonly worktree: boolean
  /**
   * `--source`, the tree to restore from. Undefined means the index for the
   * working tree and HEAD for the index.
   */
  readonly source: string | undefined
}

const ENC = new TextEncoder()

/** Read the raw restore flag kwargs into a frozen struct. */
function parseFlags(fl: FlagView): RestoreFlags {
  const staged = fl.asBool('staged')
  return { staged, worktree: fl.asBool('worktree') || !staged, source: fl.asStr('source') }
}

/** The index read as a tree: every path with its mode and blob id. */
export function indexTree(entries: ReadonlyMap<string, IndexEntry>): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>()
  for (const [path, entry] of entries)
    out.set(path, { oid: entry.oid, mode: entry.mode.toString(8) })
  return out
}

/**
 * Every path a `--source` names, commit-ish or tree-ish.
 *
 * git takes any tree-ish here, so a raw tree id
 * (`--source=$(git rev-parse HEAD^{tree})`) is as good as a branch. A
 * commit-ish is tried first because it is what the option is normally spelled
 * with and it is the only form carrying ancestry suffixes; a revision neither
 * reading resolves is unresolvable.
 */
export async function sourceTree(repo: Repo, revision: string): Promise<Map<string, TreeEntry>> {
  let found: GitObject
  try {
    found = await resolveObject(repo, revision)
  } catch {
    throw new UnresolvableSourceError(revision)
  }
  // A bare id names the object itself, so an annotated tag arrives as the tag
  // rather than as what it points at. A tag is no tree-ish, and unwrapping it
  // is what makes `--source=<tag-id>` read the same tree `--source=v1` reads.
  found = await unwrapped(repo, found, revision)
  // git's one implicit peel: a commit stands for its tree here.
  if (found.type === COMMIT) return await commitEntries(repo, found.oid)
  if (found.type !== TREE) throw new UnreadableTreeError(found.oid)
  return await treeEntries(repo, found.oid)
}

/**
 * Put paths back to what a source records.
 *
 * Two targets and one source, git's own model. `--staged` restores the index
 * and `--worktree` the working tree; the default is the working tree alone. The
 * source is the index for the working tree and HEAD for the index unless
 * `--source` names a tree, in which case a selected path the source does not
 * hold is removed from whichever target is being restored, since that is what
 * "make it match the source" means for it. Pinned against git 2.50.1.
 */
export async function restore(inv: CLIInvocation): Promise<CommandFnResult> {
  const doors = inv.doors ?? {}
  const texts = [...inv.texts]
  const fl = new FlagView(inv.flags)
  const notes: string[] = []
  try {
    const dispatch = doors.dispatch
    const statPath = doors.statPath
    if (statPath === undefined || dispatch === undefined) {
      throw new NoWorkspaceError()
    }
    checkOperands(texts, UnknownSwitchError, escaped(inv.argv), switches(inv))
    if (texts.length === 0) throw new NoRestorePathsError()
    const flags = parseFlags(fl)
    const repo = await opened(fl, doors)
    const state = await readIndex(repo, dispatch)
    const held = indexTree(state.entries)
    let source: Map<string, TreeEntry> | null
    if (flags.source !== undefined) {
      source = await sourceTree(repo, flags.source)
    } else if (flags.staged) {
      // Before the first commit there is no HEAD to restore the index from, and
      // reading that as an empty tree unstaged every selected path and reported
      // success. git refuses the whole line instead, index untouched. The
      // working tree restores from the index, so it is only the implicit HEAD
      // source that has nothing to read: `--source` naming a tree still works
      // in the same repository.
      const found = await headEntries(repo)
      if (found === null) throw new UnresolvableSourceError(HEAD)
      source = found
    } else {
      source = null
    }
    const tree = source ?? held
    // The conflict stages name paths too. An unmerged path has no stage-0
    // entry, so neither the index nor HEAD carries it and the pathspec would
    // miss what git matches: to git it is an index entry like any other.
    // Selecting it is what lets a source holding it put it back, stages and
    // all, and what lets the refusal below name it when none does.
    const names = new Set([...held.keys(), ...tree.keys(), ...state.conflicts.keys()])
    const start = startPoint(fl)
    const selected = new Set<string>()
    for (const operand of texts) {
      const hits = matched(names, repoRelative(repo.location, start, operand))
      if (hits.size === 0) throw new UnknownPathspecError(operand)
      for (const path of hits) selected.add(path)
    }
    const present = [...selected].filter((name) => tree.has(name)).sort(compareCodePoints)
    const absent = [...selected].filter((name) => !tree.has(name)).sort(compareCodePoints)
    // A selected path the source does not hold and the index still holds
    // stages for cannot be restored either way: there is no stage-0 content to
    // write into the working tree and no entry to stage. git names every one of
    // them and does none of the work, where an absent path with no stages is
    // simply removed.
    const unmerged = absent.filter((name) => state.conflicts.has(name))
    if (unmerged.length > 0) throw new UnmergedPathError(unmerged)
    const links = doors.ns?.links ?? null
    const mounts = doors.ns?.mounts ?? null
    // Before the index is written, not at the entry that meets it: `-SW`
    // stages first and restores after, so a refusal in the working-tree pass
    // would leave the index moved and the tree exactly as it was, which is the
    // one outcome this verb has no wording for.
    // A gitlink is not written into the working tree at all, so it is neither
    // read as a blob nor allowed to clear what stands at the name; keepGitlink
    // is the whole of what the entry asks for, and the preflight has nothing
    // to say about it either.
    const replacing = present.filter((name) => tree.get(name)?.mode !== GITLINK_MODE)
    // A gitlink's directory is not this verb's to empty either. The entry is a
    // placeholder for a repository mirage cannot read, so git writes the
    // directory and leaves every path under it alone: a child the source drops
    // loses its index entry and keeps its working-tree copy, edits included.
    // Removing it here is the one loss nothing can undo, since the content was
    // never staged. Pinned against git 2.50.1.
    const linked = present.filter((name) => tree.get(name)?.mode === GITLINK_MODE)
    const dropped = absent.filter((name) => !linked.some((root) => inside(name, root)))
    if (flags.worktree) {
      await refuseReplacedMounts(statPath, repo.location.worktree, replacing, links, mounts)
    }
    if (flags.staged) {
      const staged = new Map<string, StagedEntry>()
      for (const name of present) {
        const entry = tree.get(name)
        if (entry !== undefined)
          staged.set(name, restored(entry.oid, Number.parseInt(entry.mode, 8)))
      }
      await updateIndex(repo, staged, absent)
    }
    if (flags.worktree) {
      // Removals first, because the two sets can name the same place:
      // restoring a directory over a file writes `slot/child` where the
      // file `slot` still sits, and the other direction writes the file
      // where the directory still sits. Nothing is read back from the
      // working tree, so emptying it first is free.
      for (const name of dropped) {
        const path = under(repo.location.worktree, name)
        // A component above the entry that is not a directory is not a way
        // through to it: the unlink would resolve past it and delete a file
        // inside whatever it points at, which no branch named. git checks the
        // leading path and removes nothing when it finds one, so neither does
        // this.
        const blocked = await blockingAncestor(statPath, repo.location.worktree, name, links)
        if (blocked !== null) continue
        // What stands at a gitlink is a directory, so taking it away is an
        // rmdir that may legitimately fail: unlink died on it with the index
        // already written, which is the half-restore this verb has no wording
        // for.
        if (held.get(name)?.mode === GITLINK_MODE) {
          const warned = await dropGitlink(dispatch, statPath, path, name, links)
          if (warned !== null) notes.push(warned)
        } else {
          await removeFile(dispatch, path)
        }
        await removeEmptyParents(dispatch, path, repo.location.worktree, mounts)
      }
      for (const name of present) {
        const entry = tree.get(name)
        if (entry === undefined) continue
        const where = under(repo.location.worktree, name)
        if (entry.mode === GITLINK_MODE) {
          await keepGitlink(dispatch, statPath, where, links)
          continue
        }
        const { blob } = await git.readBlob({ ...repoArgs(repo), oid: entry.oid })
        // The write direction takes the same component the other way round:
        // the entry needs a directory where it stands, so git replaces it with
        // one rather than writing through it. A link's target tree is left
        // exactly as it was, and an untracked file standing there is replaced
        // in silence, which is what git's create_directories does to any
        // leading non-directory.
        const above = await blockingAncestor(statPath, repo.location.worktree, name, links)
        if (above !== null) await removeFile(dispatch, above)
        // A directory can still stand here after the loop above: it removed
        // the tracked children, but an untracked one keeps it alive and the
        // write would fail on it with the index already updated. git replaces
        // the whole directory, untracked children included. A link is left to
        // restoreEntry, which retargets it; following one to a directory here
        // would delete a tree no branch named.
        if ((links?.statAt(where) ?? null) === null) {
          const info = await statPath(where)
          if (info !== null && info.type === FileType.DIRECTORY) {
            await removeTree(dispatch, where, links, mounts)
          }
        }
        await restoreEntry(dispatch, where, entry.mode, blob, links)
      }
    }
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
  const told = notes.join('')
  return [null, told === '' ? new IOResult() : new IOResult({ stderr: ENC.encode(told) })]
}
