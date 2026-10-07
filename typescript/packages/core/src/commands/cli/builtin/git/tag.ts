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

import { PathSpec } from '../../../../types.ts'
import git from 'isomorphic-git'

import { IOResult } from '../../../../io/types.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { CLIInvocation } from '../../types.ts'
import { identity } from './commit.ts'
import { HEAD } from './constants.ts'
import { dateClock } from './dates.ts'
import {
  GitError,
  IncompatibleOptionsError,
  InvalidTagNameError,
  ListModeOnlyError,
  MissingTagMessageError,
  NoWorkspaceError,
  RefDeleteReadOnlyError,
  RefLockError,
  RefReadOnlyError,
  RefUpdateConflictError,
  TagExistsError,
  TagNotFoundError,
  TagWriteReadOnlyError,
  TooManyArgumentsError,
  UnresolvedRefError,
  UsageError,
} from './errors.ts'
import { short } from './format.ts'

import type { ReadOnlyRefusal } from './types.ts'
import { blockingRef, deleteRef, loadRefs, TAG_PREFIX, validRefName, writeRef } from './refs.ts'
import { filterWords, listModeOption, refFilter, withoutFilterValues } from './ref_filter.ts'
import { formatRefs, listingFormat, usedFields } from './ref_format.ts'
import { configuredSort, listingResult, matchShort, refListing, sortKeys } from './ref_list.ts'
import { repoArgs, type Repo } from './repo.ts'
import { opened } from './session.ts'
import { resolveObject } from './revparse.ts'
import { checkSwitches, fatal, verbUsage } from './util.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'

const ENC = new TextEncoder()
// git's own formats for a tag listing: the name, or under -n<num> the name
// padded to 15 columns and that many lines of the message.
const NAME_FORMAT = '%(refname:lstrip=2)'
const linesFormat = (lines: number): string =>
  `%(align:15)%(refname:lstrip=2)%(end) %(contents:lines=${String(lines)})`

/** The parsed shape of a `git tag` invocation. */
interface TagFlags {
  /** `-l`, list tags, the operands being patterns. */
  readonly listing: boolean
  /** `-d`, delete the named tags. */
  readonly remove: boolean
  /** `-a`, write a tag object; implied by `-m`. */
  readonly annotate: boolean
  /** `-m`, the tag message. */
  readonly message: string | undefined
  /** `-f`, replace a tag that exists. */
  readonly force: boolean
  /**
   * `-n[<num>]`, how many message lines to print per tag when listing;
   * undefined when `-n` was not given, which `-n-1` also means.
   */
  readonly lines: number | undefined
}

/**
 * Read the raw tag flag kwargs into a frozen struct.
 *
 * `-n` carries its count attached or not at all, and a bare one means one line,
 * which is why the value is read as an integer first and only then as a
 * boolean. `-m` may repeat, each occurrence a paragraph of its own.
 */
function parseFlags(fl: FlagView): TagFlags {
  let lines = fl.asInt('n')
  if (lines === undefined && fl.asBool('n')) lines = 1
  // -1 is where git's own parser starts the count, so it reads as "-n was
  // never given" rather than as a count of -1: `-n-1` deletes and creates
  // where any real `-n` refuses both.
  if (lines === -1) lines = undefined
  // Several -m are several paragraphs, joined the way git joins them.
  const paragraphs = fl.asList('message')
  const message = paragraphs.length > 0 ? paragraphs.join('\n\n') : undefined
  return {
    listing: fl.asBool('list'),
    remove: fl.asBool('delete'),
    annotate: fl.asBool('annotate') || message !== undefined,
    message,
    force: fl.asBool('force'),
    lines,
  }
}

/**
 * The object a new tag points at, and what kind it is.
 *
 * A tag made from another tag points at the tag object itself rather than at
 * what it peels to, which is git's own rule, and the type is recorded as read:
 * a lightweight tag is a ref like any other and points at whatever it was made
 * from, so `tag blobtag HEAD:a.txt` then `tag -a release -m x blobtag` records
 * `type blob`. Anything else is resolved as an object expression, because git
 * tags any object and its usage line says so: `HEAD^{tree}` and `HEAD:a.txt`
 * are as good a target as a branch.
 */
async function resolveTarget(repo: Repo, revision: string): Promise<{ oid: string; type: string }> {
  try {
    return await resolveObject(repo, revision)
  } catch {
    throw new UnresolvedRefError(revision)
  }
}

/**
 * Write an annotated tag object and return its id.
 *
 * Rendered by hand rather than through isomorphic-git's tag writer, which
 * appends a newline of its own after the message: git stores `-m x` as `x\n`
 * and an empty message as nothing at all, and the bytes decide the id.
 */
export async function buildTag(
  repo: Repo,
  name: string,
  target: { oid: string; type: string },
  message: string,
  tagger: string,
  when: number,
): Promise<string> {
  const body = message === '' ? '' : `${message}\n`
  const raw =
    `object ${target.oid}\ntype ${target.type}\ntag ${name}\n` +
    `tagger ${tagger} ${String(when)} +0000\n\n${body}`
  // Deprecated upstream in favour of writeTag, which is the writer whose extra
  // newline this exists to avoid.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  return git.writeObject({
    ...repoArgs(repo),
    type: 'tag',
    object: ENC.encode(raw),
    format: 'content',
  })
}

/**
 * List, create or delete tags.
 *
 * No operand lists them, a name creates one, `-d` deletes. A bare name is a
 * lightweight tag, a pointer and nothing more; `-a` or `-m` writes a tag object
 * carrying a message and a tagger, and `-a` without `-m` is refused for the
 * reason `commit` refuses a missing message: there is no editor to open.
 *
 * The ref filters (`--contains`, `--merged`, `--points-at` and their negations)
 * imply a listing the way `-n` does, so their operands are patterns.
 */
export async function tag(inv: CLIInvocation): Promise<CommandFnResult> {
  const doors = inv.doors ?? {}
  const words = filterWords(inv)
  const texts = withoutFilterValues(inv.texts, words)
  const filtered = words.length > 0
  const fl = new FlagView(inv.flags)
  let name: string
  let was: string | undefined
  let abbrev: number
  try {
    const dispatch = doors.dispatch
    if (dispatch === undefined) throw new NoWorkspaceError()
    checkSwitches(inv, texts)
    const flags = parseFlags(fl)
    if (flags.listing && flags.remove) throw new IncompatibleOptionsError('-l', '-d')
    // -a, -m and -f create a tag, so a line that lists or deletes instead has
    // nothing for them to do: git prints its usage and exits 129, where the
    // same line without them lists or deletes and exits 0. No operand at all is
    // a listing, which is why it counts here too.
    if (
      (flags.annotate || flags.force) &&
      (flags.listing || flags.remove || flags.lines !== undefined || filtered || texts.length === 0)
    ) {
      throw new UsageError('', verbUsage(inv))
    }
    // After the two usage refusals above, which git reaches first: `-l -d -n1`
    // is the incompatible pair and `-d -f -n1` the usage, both exiting 129,
    // where `-d -n1` alone dies here.
    if (flags.remove && flags.lines !== undefined) throw new ListModeOnlyError()
    const listOnly = flags.remove ? listModeOption(words) : null
    if (listOnly !== null) throw new ListModeOnlyError(listOnly)
    const repo = await opened(fl, doors)
    abbrev = repo.abbrev
    const keys = sortKeys(fl, await configuredSort(repo, 'tag'))
    const filter = await refFilter(repo, words)
    const known = await loadRefs(dispatch, repo.location.gitdir, repo.location.commondir)
    if (flags.remove) {
      const out: string[] = []
      const err: string[] = []
      const doomed: { name: string; ref: string; sha: string }[] = []
      for (const each of texts) {
        const ref = `${TAG_PREFIX}${each}`
        const sha = known.get(ref)
        if (sha === undefined) {
          err.push(`error: ${new TagNotFoundError(each).message}\n`)
          continue
        }
        doomed.push({ name: each, ref, sha })
      }
      // Every deletion on the line is one ref transaction, and a name given
      // twice makes two updates for one ref, which the transaction refuses
      // before applying any of them: the whole line deletes nothing. A name
      // that is not there never reaches the transaction, so `-d nosuch nosuch`
      // is two ordinary reports rather than this refusal.
      const seen = new Map<string, number>()
      for (const { ref } of doomed) seen.set(ref, (seen.get(ref) ?? 0) + 1)
      const repeated = [...seen.entries()]
        .filter(([, count]) => count > 1)
        .map(([ref]) => ref)
        .sort(compareCodePoints)
      const blamed = repeated[0]
      if (blamed !== undefined) {
        err.push(`error: ${new RefUpdateConflictError(blamed).message}\n`)
        return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(err.join('')) })]
      }
      for (const { name: each, ref, sha } of doomed) {
        await deleteRef(dispatch, repo.location.commondir, ref)
        out.push(`Deleted tag '${each}' (was ${short(sha, repo.abbrev)})\n`)
      }
      return [
        ENC.encode(out.join('')),
        new IOResult({ exitCode: err.length > 0 ? 1 : 0, stderr: ENC.encode(err.join('')) }),
      ]
    }
    if (flags.listing || flags.lines !== undefined || filtered || texts.length === 0) {
      // git reads a -n count while building the format it lists with, so a
      // count below -1 is refused as the format's own (after both usage
      // refusals above, and in a repository holding no tags), and --format
      // drops -n altogether.
      const fmt = listingFormat(
        fl.asStr('format') ?? (flags.lines ? linesFormat(flags.lines) : NAME_FORMAT),
      )
      const icase = fl.asBool('ignore_case')
      const wanted = (each: string): boolean =>
        each.startsWith(TAG_PREFIX) && matchShort(each, texts, icase)
      const [items, ctx, errors] = await refListing(
        repo,
        usedFields(fmt, keys ?? []),
        wanted,
        filter,
        dateClock(inv.env),
      )
      const [rows, stopped] = formatRefs(fmt, items, ctx, keys, {
        omitEmpty: fl.asBool('omit_empty'),
        icase,
        stream: filter === null || (filter.merged === null && filter.noMerged === null),
      })
      return listingResult(rows, errors, stopped)
    }
    if (texts.length > 2) throw new TooManyArgumentsError()
    name = texts[0] ?? ''
    if (!validRefName(name)) throw new InvalidTagNameError(name)
    const ref = `${TAG_PREFIX}${name}`
    was = known.get(ref)
    if (was !== undefined && !flags.force) throw new TagExistsError(name)
    if (flags.annotate && flags.message === undefined) throw new MissingTagMessageError()
    const target = await resolveTarget(repo, texts[1] ?? HEAD)
    let pointed = target.oid
    if (flags.annotate) {
      pointed = await buildTag(
        repo,
        name,
        target,
        flags.message ?? '',
        identity(fl, doors.sessionView).line,
        Math.floor(Date.now() / 1000),
      )
    }
    // After the object is built, which is git's order: an annotated tag whose
    // ref cannot be locked has already been written to the database and is
    // left there unreferenced.
    const held = blockingRef(new Set(known.keys()), ref)
    if (held !== null) throw new RefLockError(ref, held)
    await writeRef(dispatch, repo.location.commondir, ref, pointed)
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
  if (was === undefined) return [null, new IOResult()]
  return [ENC.encode(`Updated tag '${name}' (was ${short(was, abbrev)})\n`), new IOResult()]
}

/**
 * tag's refusal by a read-only mount: the lock on the ref it creates or
 * deletes, and for an annotated tag the object it could not write first.
 */
export const tagReadOnly: ReadOnlyRefusal = (inv, location) => {
  const fl = new FlagView(inv.flags)
  const ref = `${TAG_PREFIX}${inv.texts[0] ?? ''}`
  const path = (location?.commondir ?? PathSpec.fromStrPath('/.git')).join(ref)
  if (fl.asBool('delete')) return new RefDeleteReadOnlyError(ref, path.virtual)
  if (fl.asBool('annotate') || fl.raw('message') !== undefined) return new TagWriteReadOnlyError()
  return new RefReadOnlyError(ref, path.virtual)
}
