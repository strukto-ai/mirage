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
import { fsStrerror, isEisdir, isEnotdir, isMissingPath } from '../../../../errors/fs.ts'
import { sha1Hex } from '../../../../utils/hash.ts'
import { posixNormpath } from '../../../../utils/path.ts'
import { readStdinAsync } from '../../../builtin/utils/stream.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { CLIInvocation } from '../../types.ts'
import { OBJECT_TYPES } from './cat_file.ts'
import { GitError, NoWorkspaceError, ObjectWriteReadOnlyError } from './errors.ts'
import { readFile } from './io.ts'
import { repoArgs } from './repo.ts'
import { opened } from './session.ts'
import type { Dispatch, RepoLocation } from './types.ts'
import { checkSwitches, fatal, startPoint } from './util.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('latin1')
const HEX_ID = /^[0-9a-f]{40}$/
// fsck's ident: a name, an email in angle brackets, a time and a zone.
const IDENT = /^[^<>\n]*<[^<>\n]*> [0-9]+ [+-][0-9]{4}$/

/**
 * Whether content is the object it claims to be, the checks git's fsck makes
 * before hash-object will hash a tree, commit or tag: a tree's entries parse
 * and sort, a commit names its tree, parents, author and committer, a tag its
 * object, type and name. Mirrors Python's well_formed.
 */
function wellFormed(kind: string, data: Uint8Array): boolean {
  const text = DEC.decode(data)
  if (kind === 'tree') {
    let at = 0
    let prior: string | null = null
    while (at < text.length) {
      const space = text.indexOf(' ', at)
      const nul = text.indexOf('\0', space + 1)
      if (space === -1 || nul === -1 || nul + 21 > text.length) return false
      const mode = text.slice(at, space)
      const name = text.slice(space + 1, nul)
      if (!/^[0-7]+$/.test(mode) || name === '' || name.includes('/')) return false
      const key = name + (mode === '40000' || mode === '040000' ? '/' : '')
      if (prior !== null && !(prior < key)) return false
      prior = key
      at = nul + 21
    }
    return true
  }
  const end = text.indexOf('\n\n')
  const head = (end === -1 ? text : text.slice(0, end)).split('\n')
  if (kind === 'commit') {
    const tree = head[0] ?? ''
    if (!tree.startsWith('tree ') || !HEX_ID.test(tree.slice(5))) return false
    let rest = head.slice(1)
    while ((rest[0] ?? '').startsWith('parent ')) {
      if (!HEX_ID.test((rest[0] ?? '').slice(7))) return false
      rest = rest.slice(1)
    }
    const author = rest[0] ?? ''
    const committer = rest[1] ?? ''
    return (
      author.startsWith('author ') &&
      IDENT.test(author.slice(7)) &&
      committer.startsWith('committer ') &&
      IDENT.test(committer.slice(10))
    )
  }
  if (kind === 'tag') {
    const [object = '', type = '', name = ''] = head
    return (
      object.startsWith('object ') &&
      HEX_ID.test(object.slice(7)) &&
      type.startsWith('type ') &&
      OBJECT_TYPES.some((known) => known === type.slice(5)) &&
      name.startsWith('tag ') &&
      name.length > 4
    )
  }
  return true
}

/** The id git stores content under: the sha1 of its header and bytes. */
async function objectId(kind: string, data: Uint8Array): Promise<string> {
  const header = ENC.encode(`${kind} ${String(data.length)}\0`)
  const wrapped = new Uint8Array(header.length + data.length)
  wrapped.set(header)
  wrapped.set(data, header.length)
  return sha1Hex(wrapped)
}

/** A file's bytes, in git's words when it cannot be read. */
async function content(dispatch: Dispatch, base: string, name: string): Promise<Uint8Array> {
  try {
    return await readFile(dispatch, posixNormpath(name.startsWith('/') ? name : `${base}/${name}`))
  } catch (err) {
    if (isMissingPath(err) || isEisdir(err) || isEnotdir(err)) {
      const reason = fsStrerror(err) ?? 'No such file or directory'
      throw new GitError(`could not open '${name}' for reading: ${reason}`)
    }
    throw err
  }
}

/**
 * `git hash-object`: the id content would be stored under, read from each FILE,
 * `--stdin` or `--stdin-paths`. Another type than blob is checked first unless
 * `--literally` (without git's fsck detail lines), and `-w` writes the object.
 * Pinned against git 2.50.1.
 */
export async function hashObject(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const doors = inv.doors ?? {}
  const dispatch = doors.dispatch
  const texts = [...inv.texts]
  try {
    if (dispatch === undefined) throw new NoWorkspaceError()
    checkSwitches(inv, texts)
    const asked = fl.asStr('t') ?? 'blob'
    const kind = OBJECT_TYPES.find((type) => type === asked)
    if (kind === undefined) throw new GitError(`invalid object type "${asked}"`)
    const base = startPoint(fl)
    const contents: Uint8Array[] = []
    if (fl.asBool('stdin')) {
      contents.push((await readStdinAsync(inv.stdin ?? null)) ?? new Uint8Array())
    }
    const names = [...texts]
    if (fl.asBool('stdin_paths')) {
      const listed = new TextDecoder().decode(
        (await readStdinAsync(inv.stdin ?? null)) ?? new Uint8Array(),
      )
      names.push(...listed.split('\n').filter((line) => line !== ''))
    }
    for (const name of names) contents.push(await content(dispatch, base, name))
    if (!fl.asBool('literally') && !contents.every((data) => wellFormed(kind, data))) {
      throw new GitError('refusing to create malformed object')
    }
    if (fl.asBool('w') && contents.length > 0) {
      const repo = await opened(fl, doors)
      for (const data of contents) {
        // hash-object writes any of the four types, which only the general
        // writer takes.
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        await git.writeObject({ ...repoArgs(repo), type: kind, object: data, format: 'content' })
      }
    }
    const ids: string[] = []
    for (const data of contents) ids.push(await objectId(kind, data))
    const out = ids.map((id) => `${id}\n`).join('')
    return [out === '' ? null : ENC.encode(out), new IOResult()]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}

/**
 * hash-object's refusal by a read-only mount: the first object it could not
 * add, named as typed, `(null)` for stdin's.
 */
export function hashObjectReadOnly(inv: CLIInvocation, _location: RepoLocation | null): GitError {
  const fl = new FlagView(inv.flags)
  const first = inv.texts[0]
  return new ObjectWriteReadOnlyError(fl.asBool('stdin') || first === undefined ? '(null)' : first)
}
