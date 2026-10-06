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

import { UsageError } from '../../../errors.ts'
import { IOResult } from '../../../../io/types.ts'
import type { LinkView } from '../../../../ops/types.ts'
import { FileType, type PathSpec } from '../../../../types.ts'
import { fsStrerror, isFsError } from '../../../../errors/fs.ts'
import { mountPrefixOf, mountedPath, respelled } from '../../../../utils/key_prefix.ts'
import { CycleError, resolvePath } from '../../../../utils/path.ts'
import { rstripSlash } from '../../../../utils/slash.ts'
import { formatRecords } from '../../utils/output.ts'
import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { type Builder, requireOp, resolveGlobOf, type BuilderFn } from '../adapter.ts'

// What rmdir(2) answers for a mount point, which is what the walk up from
// -p meets at the mount root.
const MOUNT_ROOT_BUSY = 'Device or resource busy'

// An ancestor gone by the time -p reaches it held the entry just removed, so
// it was a keyed store's implicit prefix that vanished with its last key: the
// directory GNU's rmdir would have removed is already gone.
const VANISHED = 'No such file or directory'

// `virtual` with its parent resolved through the namespace's links: rmdir(2)
// follows every component but the last, which stays as named, so a link
// there is refused rather than followed. Mirrors Python's followed_parent.
function followedParent(virtual: string, links: LinkView | null): string {
  if (links === null) return virtual
  const cut = virtual.lastIndexOf('/')
  const parent = virtual.slice(0, cut) || '/'
  try {
    return `${rstripSlash(links.resolve(parent))}/${virtual.slice(cut + 1)}`
  } catch (err) {
    if (!(err instanceof CycleError)) throw err
    console.warn(`rmdir: following ${parent} failed: ${String(err)}`)
    return virtual
  }
}

// The directories -p removes after `path`, as GNU cuts them from the
// operand as typed, each with its spelling. null stands for the mount root,
// which is a mount point and is never removed. Each is reached through the
// links in its parent, as GNU's rmdir(2) is: `rmdir -p link/nested/leaf`
// removes the directory `link/nested` names. Mirrors Python's ancestors.
export function ancestors(
  path: PathSpec,
  cwd: string,
  links: LinkView | null = null,
): [PathSpec | null, string][] {
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  let typed = rstripSlash(path.rawPath) || '/'
  const chain: [PathSpec | null, string][] = []
  while (typed.includes('/')) {
    let cut = typed.lastIndexOf('/')
    while (cut > 0 && typed[cut] === '/') cut -= 1
    typed = typed.slice(0, cut + 1)
    const literal = rstripSlash(resolvePath(typed, cwd))
    if (!literal.startsWith(`${prefix}/`)) {
      chain.push([null, typed])
      break
    }
    // A parent linked onto another mount is out of this mount's reach, so
    // the name is tried here as typed.
    const followed = followedParent(literal, links)
    const virtual = followed.startsWith(`${prefix}/`) ? followed : literal
    chain.push([respelled(mountedPath(path, virtual.slice(prefix.length)), typed), typed])
  }
  return chain
}

const rmdir: BuilderFn = async (ops, accessor, paths, _texts, opts) => {
  if (paths.length === 0) {
    throw new UsageError("rmdir: missing operand\nTry 'rmdir --help' for more information.", 1)
  }
  const idx = opts.index ?? undefined
  const resolved = await resolveGlobOf(ops)(accessor, paths, idx)
  const fl = new FlagView(opts.flags, specOf('rmdir'))
  const verbose = fl.asBool('verbose')
  const ignore = fl.asBool('ignore_fail_on_non_empty')
  const rmdirOp = requireOp(ops.rmdir, 'rmdir')
  const lines: string[] = []
  const errors: string[] = []
  const links = opts.ns?.links ?? null
  const remove = async (p: PathSpec): Promise<string | null> => {
    // rmdir(2) never follows, so a link operand never reaches the
    // directory it points at. GNU words the two spellings apart: a bare
    // link is the plain ENOTDIR, while one typed with a trailing slash
    // gets rmdir's own "Symbolic link not followed", since the slash
    // asked for a directory the call refuses to resolve. No backend can
    // see a link, so the name plane answers.
    if (links !== null && links.statAt(p.virtual) !== null) {
      return p.rawPath.endsWith('/') ? 'Symbolic link not followed' : 'Not a directory'
    }
    let isDir = false
    try {
      const st = await ops.stat(accessor, p, idx)
      isDir = st.type === FileType.DIRECTORY
    } catch (exc) {
      if (!isFsError(exc)) throw exc
      return fsStrerror(exc) ?? String(exc)
    }
    if (!isDir) return 'Not a directory'
    if ((await ops.readdir(accessor, p, idx)).length > 0) return 'Directory not empty'
    try {
      await rmdirOp(accessor, p, idx)
    } catch (exc) {
      // The listing above showed the session an empty directory, but
      // the slot may still refuse not-empty: the hidden-remnant guard
      // re-raises the backend's refusal when its cascade cannot
      // finish (a mode-protected remnant, a visible entry appearing
      // mid-walk). A read-only region refuses here too. GNU's voice, not
      // the raw error.
      const code = (exc as { code?: string }).code
      const detail =
        code === 'ENOTEMPTY' || code === 'EEXIST' ? 'Directory not empty' : fsStrerror(exc)
      if (detail === null) throw exc
      return detail
    }
    return null
  }
  for (const p of resolved) {
    if (verbose) lines.push(`rmdir: removing directory, '${p.rawPath}'`)
    const reason = await remove(p)
    if (reason !== null) {
      if (!(ignore && reason === 'Directory not empty')) {
        errors.push(`rmdir: failed to remove '${p.rawPath}': ${reason}`)
      }
      continue
    }
    if (!fl.asBool('parents')) continue
    for (const [ancestor, typed] of ancestors(p, opts.cwd, links)) {
      if (verbose) lines.push(`rmdir: removing directory, '${typed}'`)
      const failed = ancestor === null ? MOUNT_ROOT_BUSY : await remove(ancestor)
      if (failed === null || failed === VANISHED) continue
      if (!(ignore && failed === 'Directory not empty')) {
        const what = failed === 'Not a directory' ? '' : 'directory '
        errors.push(`rmdir: failed to remove ${what}'${typed}': ${failed}`)
      }
      break
    }
  }
  const out = lines.length > 0 ? formatRecords(lines) : null
  const stderr = errors.length > 0 ? new TextEncoder().encode(errors.join('\n') + '\n') : undefined
  return [
    out,
    new IOResult({
      exitCode: errors.length > 0 ? 1 : 0,
      ...(stderr !== undefined ? { stderr } : {}),
    }),
  ]
}

export const BUILDER: Builder = {
  name: 'rmdir',
  write: true,
  fn: rmdir,
}
