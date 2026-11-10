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
import { encodeText, decodeText } from '../../../../shell/bytes.ts'
import type { PathSpec } from '../../../../types.ts'
import { readStdinAsync } from '../../../builtin/utils/stream.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { stagedEntries } from './changes.ts'
import { EmptyPathspecError, GitError, UsageError } from './errors.ts'
import {
  GITIGNORE,
  lastMatch,
  loadIgnoreFiles,
  parseRules,
  type IgnoreFile,
  type Rule,
} from './ignore.ts'
import { readIndex } from './index_file.ts'
import { isDirectory, readOptional } from './io.ts'
import { parentOf } from './ls_files.ts'
import { repoRelative } from './pathspec.ts'
import { quotePath } from './render.ts'
import { configBool, type Repo } from './repo.ts'
import { opened } from './session.ts'
import type { IndexState, RepoLocation } from './types.ts'
import { fatal, loneHelp, optionOperand, requireVfs, startPoint, verbUsage } from './util.ts'

const QUOTE = 0x22
const BACKSLASH = 0x5c
const OCTAL_DIGITS = 3
const OCTAL_BASE = 8
const BYTE_LIMIT = 256
const ESCAPES: ReadonlyMap<number, number> = new Map([
  [0x61, 7],
  [0x62, 8],
  [0x66, 12],
  [0x6e, 10],
  [0x72, 13],
  [0x74, 9],
  [0x76, 11],
  [BACKSLASH, BACKSLASH],
  [QUOTE, QUOTE],
])
const BADLY_QUOTED = 'line is badly quoted'
const NO_MATCH: readonly [string, string, string] = ['', '', '']

/** One C-quoted line, read up to its closing quote. */
function unquoted(line: Uint8Array): Uint8Array {
  const out: number[] = []
  let at = 1
  while (at < line.length) {
    const byte = line[at] ?? 0
    if (byte === QUOTE) return Uint8Array.from(out)
    if (byte !== BACKSLASH) {
      out.push(byte)
      at += 1
      continue
    }
    const escaped = ESCAPES.get(line[at + 1] ?? -1)
    if (escaped !== undefined) {
      out.push(escaped)
      at += 2
      continue
    }
    const digits = String.fromCharCode(...line.subarray(at + 1, at + 1 + OCTAL_DIGITS))
    if (digits.length !== OCTAL_DIGITS || !/^[0-7]+$/.test(digits)) throw new GitError(BADLY_QUOTED)
    const value = Number.parseInt(digits, OCTAL_BASE)
    if (value >= BYTE_LIMIT) throw new GitError(BADLY_QUOTED)
    out.push(value)
    at += 1 + OCTAL_DIGITS
  }
  throw new GitError(BADLY_QUOTED)
}

/** Refuse an option set git refuses, in the order git checks them. */
function refuseOptions(fl: FlagView, texts: readonly string[]): void {
  const reading = fl.asBool('stdin')
  const quiet = fl.asBool('quiet')
  const verbose = fl.asBool('verbose')
  if (reading && texts.length > 0) throw new GitError('cannot specify pathnames with --stdin')
  if (fl.asBool('z') && !reading) throw new GitError('-z only makes sense with --stdin')
  if (!reading && texts.length === 0) throw new GitError('no path specified')
  if (quiet && texts.length > 1) {
    throw new GitError('--quiet is only valid with a single pathname')
  }
  if (quiet && verbose) throw new GitError('cannot have both --quiet and --verbose')
  if (fl.asBool('non_matching') && !verbose) {
    throw new GitError('--non-matching is only valid with --verbose')
  }
}

function pathOf(location: RepoLocation, start: string, word: string): string {
  if (word === '') throw new EmptyPathspecError()
  return repoRelative(location, start, word)
}

/** Every indexed path and every directory above one. */
function tracked(state: IndexState): Set<string> {
  const seen = new Set<string>()
  for (const path of [...stagedEntries(state).keys(), ...state.conflicts.keys()]) {
    let name = path
    while (name !== '' && !seen.has(name)) {
      seen.add(name)
      name = parentOf(name)
    }
  }
  return seen
}

/** The ignore files governing one directory, innermost last. */
async function filesOf(
  repo: Repo,
  known: Map<string, IgnoreFile[]>,
  directory: string,
): Promise<IgnoreFile[]> {
  const held = known.get(directory)
  if (held !== undefined) return held
  const above = await filesOf(repo, known, parentOf(directory))
  const data = await readOptional(repo.vfs, repo.location.worktree.join(directory).join(GITIGNORE))
  const files =
    data === null
      ? above
      : [
          ...above,
          {
            prefix: directory,
            source: `${directory}/${GITIGNORE}`,
            rules: parseRules(new TextDecoder().decode(data)),
          },
        ]
  known.set(directory, files)
  return files
}

/**
 * The rule that decides a path, walking down from the top. A directory an
 * exclude rule catches decides everything below it, since git never looks
 * inside to read a line that might re-include a child.
 */
async function verdict(
  repo: Repo,
  known: Map<string, IgnoreFile[]>,
  path: string,
  isDir: boolean,
): Promise<[IgnoreFile, Rule] | null> {
  const parts = path.split('/')
  for (let depth = 1; depth < parts.length; depth += 1) {
    const parent = parts.slice(0, depth).join('/')
    const found = lastMatch(await filesOf(repo, known, parentOf(parent)), parent, true)
    if (found !== null && !found[1].negated) return found
  }
  return lastMatch(await filesOf(repo, known, parentOf(path)), path, isDir)
}

function row(
  word: string,
  fields: readonly [string, string, string],
  zero: boolean,
  fully: boolean,
  verbose: boolean,
): string {
  if (zero) return `${verbose ? fields.map((field) => `${field}\0`).join('') : ''}${word}\0`
  const head = verbose ? `${fields[0]}:${fields[1]}:${fields[2]}\t` : ''
  return `${head}${quotePath(word, false, fully)}\n`
}

/**
 * Say which paths the ignore rules cover. Operands are checked before any
 * answer; lines read with `--stdin` are checked one at a time, so the answers
 * before a bad line stand. Exits 0 when any path was covered and 1 when none
 * was.
 */
export async function checkIgnore(
  _accessor: NOOPAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const vfs = requireVfs(ctx)
  if (optionOperand(ctx, texts, loneHelp(ctx, texts)) !== null) {
    throw new UsageError('', verbUsage(ctx))
  }
  const repo = await opened(ctx, fl, true)
  refuseOptions(fl, texts)
  const start = startPoint(fl).virtual
  for (const word of texts) pathOf(repo.location, start, word)
  const reading = fl.asBool('stdin')
  const zero = fl.asBool('z')
  const quiet = fl.asBool('quiet')
  const verbose = fl.asBool('verbose')
  const nonMatching = fl.asBool('non_matching')
  const fully = await configBool(repo, 'core.quotepath', true)
  const indexed = fl.asBool('no_index')
    ? new Set<string>()
    : tracked(await readIndex(repo, repo.vfs))
  const items = reading
    ? decodeText((await readStdinAsync(ctx.stdin)) ?? new Uint8Array()).split(zero ? '\0' : '\n')
    : [...texts]
  if (reading && items.at(-1) === '') items.pop()
  const known = new Map([['', await loadIgnoreFiles(vfs, repo.location)]])
  let out = ''
  let covered = false
  try {
    for (const item of items) {
      const word =
        reading && !zero && item.startsWith('"') ? decodeText(unquoted(encodeText(item))) : item
      const path = pathOf(repo.location, start, word)
      let found: [IgnoreFile, Rule] | null = null
      if (path !== '' && !indexed.has(path)) {
        const isDir =
          word.endsWith('/') || (await isDirectory(vfs, repo.location.worktree.join(path)))
        found = await verdict(repo, known, path, isDir)
      }
      if (found === null) {
        if (verbose && nonMatching) out += row(word, NO_MATCH, zero, fully, verbose)
        continue
      }
      const [source, rule] = found
      if (!verbose && rule.negated) continue
      covered = true
      if (!quiet)
        out += row(word, [source.source, String(rule.line), rule.text], zero, fully, verbose)
    }
  } catch (err) {
    if (!(err instanceof GitError)) throw err
    const refused = fatal(err)
    return refused === null ? refused : [out === '' ? null : encodeText(out), refused[1]]
  }
  return [out === '' ? null : encodeText(out), new IOResult({ exitCode: covered ? 0 : 1 })]
}
