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

import { IOResult } from '../../../../io/types.ts'
import { FileType } from '../../../../types.ts'
import { cpWalk } from '../../generic/cp.ts'
import { formatRecords } from '../../utils/output.ts'
import { removalLines } from '../../utils/verbose.ts'
import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/types.ts'
import { isSlashedLink, rmLinkRefusal } from '../../utils/slash_links.ts'
import { type Builder, resolveGlobOf } from '../adapter.ts'

export const RM_BUILDER: Builder = {
  name: 'rm',
  write: true,
  requirements: ['unlink'],
  fn: async (ops, accessor, paths, _texts, opts) => {
    if (paths.length === 0) {
      return [
        null,
        new IOResult({ exitCode: 1, stderr: new TextEncoder().encode('rm: missing operand\n') }),
      ]
    }
    const idx = opts.index ?? undefined
    const resolved = await resolveGlobOf(ops)(accessor, paths, idx)
    const fl = new FlagView(opts.flags, specOf('rm'))
    const recursive = fl.asBool('r') || fl.asBool('R')
    const dirFlag = fl.asBool('d')
    const force = fl.asBool('f')
    const verbose = fl.asBool('v')
    const { rmR, rmdir, unlink } = ops
    if (unlink === undefined) {
      throw new Error('rm: backend provides no remove op')
    }
    const lines: string[] = []
    const errors: string[] = []
    const links = opts.ns?.links ?? null
    for (const p of resolved) {
      if (isSlashedLink(p, links)) {
        const refusal = await rmLinkRefusal(p, links, { recursive, force })
        if (refusal !== null) errors.push(refusal)
        continue
      }
      let isDir = false
      try {
        const st = await ops.stat(accessor, p, idx)
        isDir = st.type === FileType.DIRECTORY
      } catch (err) {
        if (force) continue
        // A trailing slash that named something which is not a directory
        // (`rm reg/`); otherwise the operand is simply absent. GNU rm
        // reports it and keeps removing the rest.
        const detail =
          (err as { code?: string }).code === 'ENOTDIR'
            ? 'Not a directory'
            : 'No such file or directory'
        errors.push(`rm: cannot remove '${p.rawPath}': ${detail}`)
        continue
      }
      let entryLines: string[] = []
      if (isDir) {
        // rmR/rmdir are resolved lazily so object stores without a real
        // directory-remove op still unlink plain files (mirrors Python).
        if (recursive) {
          if (rmR === undefined) {
            throw new Error('rm: recursive remove not supported on this backend')
          }
          if (verbose) {
            entryLines = removalLines(
              await cpWalk(
                (dir) => ops.readdir(accessor, dir, idx),
                (spec) => ops.stat(accessor, spec, idx),
                p,
                idx,
              ),
            )
          }
          await rmR(accessor, p)
        } else if (dirFlag) {
          if (rmdir === undefined) {
            throw new Error('rm: directory remove not supported on this backend')
          }
          if ((await ops.readdir(accessor, p, idx)).length > 0) {
            errors.push(`rm: cannot remove '${p.rawPath}': Directory not empty`)
            continue
          }
          await rmdir(accessor, p)
          entryLines = [`removed directory '${p.virtual}'`]
        } else {
          errors.push(`rm: cannot remove '${p.rawPath}': Is a directory`)
          continue
        }
      } else {
        await unlink(accessor, p)
        entryLines = [`removed '${p.virtual}'`]
      }
      if (verbose) lines.push(...entryLines)
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
