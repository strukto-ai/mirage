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
import { FileType } from '../../../../types.ts'
import { fsStrerror, isEnotdir } from '../../../../utils/errors.ts'
import { formatRecords } from '../../utils/output.ts'
import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { type Builder, requireOp, resolveGlobOf } from '../adapter.ts'

export const RMDIR_BUILDER: Builder = {
  name: 'rmdir',
  write: true,
  fn: async (ops, accessor, paths, _texts, opts) => {
    if (paths.length === 0) {
      throw new UsageError("rmdir: missing operand\nTry 'rmdir --help' for more information.", 1)
    }
    const idx = opts.index ?? undefined
    const resolved = await resolveGlobOf(ops)(accessor, paths, idx)
    const verbose = new FlagView(opts.flags, specOf('rmdir')).asBool('v')
    const rmdir = requireOp(ops.rmdir, 'rmdir')
    const lines: string[] = []
    const errors: string[] = []
    const links = opts.ns?.links ?? null
    for (const p of resolved) {
      // rmdir(2) never follows, so a link operand never reaches the
      // directory it points at. GNU words the two spellings apart: a bare
      // link is the plain ENOTDIR, while one typed with a trailing slash
      // gets rmdir's own "Symbolic link not followed", since the slash
      // asked for a directory the call refuses to resolve. No backend can
      // see a link, so the name plane answers.
      if (links !== null && links.statAt(p.virtual) !== null) {
        const detail = p.rawPath.endsWith('/') ? 'Symbolic link not followed' : 'Not a directory'
        errors.push(`rmdir: failed to remove '${p.rawPath}': ${detail}`)
        continue
      }
      let isDir = false
      try {
        const st = await ops.stat(accessor, p, idx)
        isDir = st.type === FileType.DIRECTORY
      } catch (exc) {
        const detail = isEnotdir(exc) ? 'Not a directory' : 'No such file or directory'
        errors.push(`rmdir: failed to remove '${p.rawPath}': ${detail}`)
        continue
      }
      if (!isDir) {
        errors.push(`rmdir: failed to remove '${p.rawPath}': Not a directory`)
        continue
      }
      if ((await ops.readdir(accessor, p, idx)).length > 0) {
        errors.push(`rmdir: failed to remove '${p.rawPath}': Directory not empty`)
        continue
      }
      try {
        await rmdir(accessor, p, idx)
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
        errors.push(`rmdir: failed to remove '${p.rawPath}': ${detail}`)
        continue
      }
      if (verbose) lines.push(`rmdir: removing directory, '${p.rawPath}'`)
    }
    const out = lines.length > 0 ? formatRecords(lines) : null
    const stderr =
      errors.length > 0 ? new TextEncoder().encode(errors.join('\n') + '\n') : undefined
    return [
      out,
      new IOResult({
        exitCode: errors.length > 0 ? 1 : 0,
        ...(stderr !== undefined ? { stderr } : {}),
      }),
    ]
  },
}
