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

import type { Stats } from 'ssh2'
import { FileStat, FileType, type PathSpec } from '@struktoai/mirage-core/types'
import { epochToIso } from '@struktoai/mirage-core/utils/dates'
import { eacces, enoent } from '@struktoai/mirage-core/errors/fs'
import { contentTypeForPath } from '@struktoai/mirage-core/utils/filetype'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import { singleQuote } from '@struktoai/mirage-core/utils/quote'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import {
  S_IFDIR,
  S_IFREG,
  isDirectoryAttrs,
  isNoSuchFile,
  isPermissionDenied,
  joinRoot,
  stripPrefix,
} from './utils.ts'

export const FIND = 'env LC_ALL=C find -L'
export const TREE_FORMAT = '%y %m %s %T@ %A@ %U %G %P\\0'
const FIND_TYPES: Readonly<Record<string, number>> = { d: S_IFDIR, f: S_IFREG }

export interface SshAttrs {
  size?: number
  mode?: number
  mtime?: number
  atime?: number
  uid?: number
  gid?: number
}

export function attrsToFileStat(name: string, attrs: SshAttrs): FileStat {
  const modified = attrs.mtime !== undefined ? epochToIso(attrs.mtime) : null
  const extra: Record<string, unknown> = {}
  if (attrs.mode !== undefined) extra.mode = attrs.mode
  if (attrs.uid !== undefined) extra.uid = attrs.uid
  if (attrs.gid !== undefined) extra.gid = attrs.gid
  // Fields setattr applies natively (mode, times) surface from the
  // remote inode, so external chmod/utime stays visible, mirroring
  // disk. Ownership can never be applied natively (chown over SFTP
  // needs privileges), so it lives wholly in the namespace overlay;
  // server-side uid/gid stay in extra only.
  const mode = attrs.mode !== undefined ? attrs.mode & 0o7777 : null
  const atime = attrs.atime !== undefined ? epochToIso(attrs.atime) : null
  // The remote mtime is the only cheap change token SFTP offers, so it is
  // also the fingerprint: without one, a `read: fresh` mount has
  // nothing to compare and keeps serving a cached copy that the server has
  // already replaced. Mirrors the python stat.
  if (isDirectoryAttrs(attrs)) {
    return new FileStat({
      name,
      size: null,
      modified,
      fingerprint: modified,
      type: FileType.DIRECTORY,
      mode,
      atime,
      extra,
    })
  }
  return new FileStat({
    name,
    size: attrs.size ?? null,
    modified,
    fingerprint: modified,
    type: FileType.FILE,
    content: contentTypeForPath(name),
    mode,
    atime,
    extra,
  })
}

export async function stat(accessor: SSHAccessor, p: PathSpec): Promise<FileStat> {
  const sftp = await accessor.sftp()
  const virtual = stripPrefix(p)
  const remote = joinRoot(accessor.config.root ?? '/', virtual)
  const attrs = await new Promise<Stats>((resolveFn, rejectFn) => {
    // Follow symlinks (stat, not lstat), like the Python core: reads
    // follow the link, so the reported size must be the target's.
    sftp.stat(remote, (err, stats) => {
      if (err !== undefined) {
        if (isNoSuchFile(err)) rejectFn(enoent(p))
        else rejectFn(isPermissionDenied(err) ? eacces(p) : err)
        return
      }
      resolveFn(stats)
    })
  })
  const cleaned = rstripSlash(virtual)
  const name = cleaned.length === 0 ? '/' : (cleaned.split('/').pop() ?? '/')
  return attrsToFileStat(name, attrs)
}

/**
 * The remote find that lists `scope` and everything below it, links
 * followed, one NUL-ended record per entry. Mirrors Python's `tree_command`.
 */
export function treeCommand(scope: string): string {
  return `${FIND} ${singleQuote(scope)} -printf ${singleQuote(TREE_FORMAT)}`
}

/**
 * Every file and directory under a directory, each as `stat` answers it, from
 * one find on the server, where a walk sends a readdir per directory.
 *
 * Only an exit of 0 with nothing on stderr, a directory at `p`, and entries
 * that are each a directory or a regular file answer: a server that runs no
 * commands, a find without `-printf` (busybox, BSD), an entry it could not
 * read, a link loop, a broken link or a special file leaves the walk to
 * readdir, which reports each as it does today. Mirrors Python's `tree`.
 */
export async function tree(
  accessor: SSHAccessor,
  p: PathSpec,
): Promise<Map<string, FileStat> | null> {
  const scope = joinRoot(accessor.config.root ?? '/', stripPrefix(p))
  let status: number | null
  let out: Uint8Array
  let err: Uint8Array
  try {
    ;[status, out, err] = await accessor.run(treeCommand(scope))
  } catch (error) {
    console.debug(`ssh tree left to the walk: ${String(error)}`)
    return null
  }
  if (status !== 0 || err.length > 0 || out[out.length - 1] !== 0) return null
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const rows = new Map<string, FileStat>()
  let top = false
  let start = 0
  for (let end = out.indexOf(0); end !== -1; end = out.indexOf(0, start)) {
    let fields: string[]
    try {
      fields = decoder.decode(out.subarray(start, end)).split(' ')
    } catch (error) {
      console.debug(`ssh tree left to the walk: ${String(error)}`)
      return null
    }
    start = end + 1
    const attrs = findAttrs(fields)
    if (attrs === null) return null
    const rel = fields.slice(7).join(' ')
    if (rel === '') {
      top = isDirectoryAttrs(attrs)
      continue
    }
    rows.set(rel, attrsToFileStat(rel.split('/').pop() ?? rel, attrs))
  }
  return top ? rows : null
}

// One find record's fields as SFTP attributes, or null for a record that is
// not a directory or a regular file, or that does not parse.
function findAttrs(fields: readonly string[]): SshAttrs | null {
  const [kind = '', mode = '', size = '', mtime = '', atime = '', uid = '', gid = ''] = fields
  const type = FIND_TYPES[kind]
  if (type === undefined || fields.length < 8 || !/^[0-7]+$/.test(mode)) return null
  if (![size, uid, gid].every((n) => /^\d+$/.test(n))) return null
  if (![mtime, atime].every((t) => /^-?\d+(\.\d*)?$/.test(t))) return null
  return {
    mode: type | Number.parseInt(mode, 8),
    size: Number(size),
    mtime: Number(mtime.split('.')[0]),
    atime: Number(atime.split('.')[0]),
    uid: Number(uid),
    gid: Number(gid),
  }
}
