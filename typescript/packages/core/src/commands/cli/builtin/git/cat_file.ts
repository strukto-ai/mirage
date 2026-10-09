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
import { readStdinAsync } from '../../../builtin/utils/stream.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { CLIInvocation } from '../../types.ts'
import {
  AmbiguousArgumentError,
  GitError,
  IncompatibleOptionsError,
  InvalidRevisionNameError,
  NoWorkspaceError,
  UsageError,
} from './errors.ts'
import { repoArgs, type Repo } from './repo.ts'
import { resolveObject } from './revparse.ts'
import { opened } from './session.ts'
import type { GitObject } from './types.ts'
import { checkSwitches, fatal, verbUsage } from './util.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

export const OBJECT_TYPES = ['blob', 'tree', 'commit', 'tag'] as const
// The query modes, each named by the switch that selects it.
const QUERIES = ['t', 's', 'e', 'p']
const BATCH_FORMAT = '%(objectname) %(objecttype) %(objectsize)'
const FORMAT_ATOM = /%\(([^)]*)\)/g
const BATCH_ATOMS: ReadonlySet<string> = new Set(['objectname', 'objecttype', 'objectsize', 'rest'])
const HEX_ID = /^[0-9a-f]{40}$/

/** The object a name stands for, in cat-file's words when it stands for none. */
async function namedObject(repo: Repo, name: string): Promise<GitObject> {
  try {
    return await resolveObject(repo, name)
  } catch (err) {
    if (err instanceof AmbiguousArgumentError || err instanceof InvalidRevisionNameError) {
      throw new GitError(`Not a valid object name ${name}`)
    }
    throw err
  }
}

/** An object's bytes as stored. */
async function raw(repo: Repo, oid: string): Promise<Uint8Array> {
  // cat-file prints the stored content of any type, which only the general
  // reader returns.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const read = await git.readObject({ ...repoArgs(repo), oid, format: 'content' })
  return read.object as Uint8Array
}

/**
 * An object peeled down to a type, git's read_object_with_reference: a tag to
 * what it points at and a commit to its tree; null when the chain never
 * reaches the type.
 */
async function peeled(repo: Repo, obj: GitObject, want: string): Promise<GitObject | null> {
  let at = obj
  while (at.type !== want) {
    if (at.type === 'tag') {
      const { tag } = await git.readTag({ ...repoArgs(repo), oid: at.oid })
      at = { oid: tag.object, type: tag.type }
    } else if (at.type === 'commit' && want === 'tree') {
      const { commit } = await git.readCommit({ ...repoArgs(repo), oid: at.oid })
      at = { oid: commit.tree, type: 'tree' }
    } else {
      return null
    }
  }
  return at
}

/** `-p`: a tree as ls-tree lists it, any other object as stored. */
async function pretty(repo: Repo, obj: GitObject): Promise<Uint8Array> {
  if (obj.type !== 'tree') return raw(repo, obj.oid)
  const { tree } = await git.readTree({ ...repoArgs(repo), oid: obj.oid })
  return ENC.encode(
    tree
      .map((entry) => `${entry.mode.padStart(6, '0')} ${entry.type} ${entry.oid}\t${entry.path}\n`)
      .join(''),
  )
}

/** One query mode's answer for one name, and its exit status. */
async function query(repo: Repo, mode: string, name: string): Promise<[Uint8Array, number]> {
  if (mode === 'e' && HEX_ID.test(name)) {
    try {
      await raw(repo, name)
      return [new Uint8Array(), 0]
    } catch {
      return [new Uint8Array(), 1]
    }
  }
  const obj = await namedObject(repo, name)
  if (mode === 't') return [ENC.encode(`${obj.type}\n`), 0]
  if (mode === 's') return [ENC.encode(`${String((await raw(repo, obj.oid)).length)}\n`), 0]
  if (mode === 'e') return [new Uint8Array(), 0]
  return [await pretty(repo, obj), 0]
}

/**
 * One `--batch`/`--batch-check` format line and the id it names, `<name>
 * missing` and null for a name that stands for nothing. With `%(rest)` in the
 * format the name ends at the first blank and the rest of the line is
 * `%(rest)`.
 */
async function batchHead(
  repo: Repo,
  line: string,
  template: string,
): Promise<[Uint8Array, string | null]> {
  let name = line
  let rest = ''
  if (template.includes('%(rest)')) {
    const blank = line.indexOf(' ')
    if (blank !== -1) {
      name = line.slice(0, blank)
      rest = line.slice(blank + 1)
    }
  }
  let obj: GitObject
  try {
    obj = await resolveObject(repo, name)
  } catch (err) {
    if (err instanceof GitError) return [ENC.encode(`${name} missing\n`), null]
    throw err
  }
  const atoms: Record<string, string> = {
    objectname: obj.oid,
    objecttype: obj.type,
    objectsize: String((await raw(repo, obj.oid)).length),
    rest,
  }
  const head = template.replace(FORMAT_ATOM, (_, atom: string) => atoms[atom] ?? '')
  return [ENC.encode(`${head}\n`), obj.oid]
}

/**
 * The batch answers in order, each object's bytes read only when its turn
 * comes, so a long `--batch` never holds every object at once; a record goes out
 * whole or not at all.
 */
async function* batchLines(
  repo: Repo,
  heads: readonly [Uint8Array, string | null][],
  contents: boolean,
): AsyncIterable<Uint8Array> {
  for (const [head, oid] of heads) {
    const body = contents && oid !== null ? await raw(repo, oid) : null
    yield head
    if (body !== null) {
      yield body
      yield ENC.encode('\n')
    }
  }
}

/**
 * `git cat-file`: an object's type, size, existence or content, for one name, a
 * `<type> <object>` pair or each stdin line under `--batch`. Pinned against git
 * 2.50.1.
 */
export async function catFile(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const view = inv.view ?? {}
  const texts = [...inv.texts]
  try {
    if (view.dispatch === undefined) throw new NoWorkspaceError()
    checkSwitches(inv, texts)
    const modes = fl.typedOrder(...QUERIES)
    const [first, second] = modes
    if (first !== undefined && second !== undefined) {
      throw new IncompatibleOptionsError(`-${second}`, `-${first}`)
    }
    const batch = fl.typedOrder('batch', 'batch_check').at(-1)
    if (batch !== undefined) {
      if (texts.length > 0) {
        throw new UsageError('', 'fatal: batch modes take no arguments\n\n' + verbUsage(inv))
      }
      const value = fl.raw(batch)
      const template = typeof value === 'string' ? value : BATCH_FORMAT
      for (const found of template.matchAll(FORMAT_ATOM)) {
        if (!BATCH_ATOMS.has(found[1] ?? '')) {
          throw new GitError(`bad cat-file format: ${found[0]}`)
        }
      }
      const repo = await opened(fl, view)
      const text = DEC.decode((await readStdinAsync(inv.stdin ?? null)) ?? new Uint8Array())
      const lines = text.split('\n')
      if (lines.at(-1) === '') lines.pop()
      const heads: [Uint8Array, string | null][] = []
      for (const line of lines) heads.push(await batchHead(repo, line, template))
      return [batchLines(repo, heads, batch === 'batch'), new IOResult()]
    }
    if (first === undefined && texts.length === 0) throw new UsageError('', verbUsage(inv))
    if (first !== undefined) {
      const name = texts[0]
      if (name === undefined) {
        throw new UsageError('', `fatal: <object> required with '-${first}'\n\n` + verbUsage(inv))
      }
      if (texts.length > 1) {
        throw new UsageError('', 'fatal: too many arguments\n\n' + verbUsage(inv))
      }
      const repo = await opened(fl, view)
      const [out, code] = await query(repo, first, name)
      return [out.length > 0 ? out : null, new IOResult({ exitCode: code })]
    }
    const [kind, name] = texts
    if (kind === undefined || name === undefined || texts.length !== 2) {
      throw new UsageError(
        '',
        'fatal: only two arguments allowed in <type> <object> mode, ' +
          `not ${String(texts.length)}\n\n` +
          verbUsage(inv),
      )
    }
    if (!OBJECT_TYPES.some((type) => type === kind)) {
      throw new GitError(`invalid object type "${kind}"`)
    }
    const repo = await opened(fl, view)
    const obj = await peeled(repo, await namedObject(repo, name), kind)
    if (obj === null) throw new GitError(`git cat-file ${name}: bad file`)
    return [await raw(repo, obj.oid), new IOResult()]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}
