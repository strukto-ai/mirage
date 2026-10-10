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
import { FileType, type FileStat, type PathSpec } from '../../../../types.ts'
import { cpWalk } from '../../generic/cp.ts'
import { removeTree, rmWithoutOperands } from '../../generic/rm_cmd.ts'
import { formatRecords } from '../../utils/output.ts'
import { mountPoints } from '../../utils/operands.ts'
import { removalLines } from '../../utils/verbose.ts'
import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { isSlashedLink, rmLinkRefusal } from '../../utils/slash_links.ts'
import {
  errorVirtualPath,
  fsStrerror,
  isEnoent,
  isEnotdir,
  isFsError,
} from '../../../../errors/fs.ts'
import { operandSpelling } from '../../../../errors/render.ts'
import { type GenericCommand, requireOp, resolveGlobOf, type GenericCommandFn } from '../adapter.ts'

const rm: GenericCommandFn = async (ops, accessor, paths, _texts, opts) => {
  const fl = new FlagView(opts.flags, specOf('rm'))
  const recursive = fl.asBool('r') || fl.asBool('R')
  const dirFlag = fl.asBool('d')
  const force = fl.asBool('f')
  const verbose = fl.asBool('v')
  if (paths.length === 0) return rmWithoutOperands(force)
  const idx = opts.index ?? undefined
  const resolved = await resolveGlobOf(ops)(accessor, paths, idx)
  const rmR = requireOp(ops.rmR, 'rmR')
  const rmdir = requireOp(ops.rmdir, 'rmdir')
  const unlink = requireOp(ops.unlink, 'unlink')
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
      if (!isFsError(err)) throw err
      // ENOTDIR is a component that is a plain file: the operand sits
      // under one, or carried a trailing slash that named one (`rm reg/`).
      // -f ignores it and ENOENT alone, as GNU's `ignorable_missing` does;
      // any other failure is reported, -f or not. GNU rm reports the
      // operand and keeps removing the rest.
      if (force && (isEnoent(err) || isEnotdir(err))) continue
      errors.push(`rm: cannot remove '${p.rawPath}': ${fsStrerror(err) ?? String(err)}`)
      continue
    }
    let entryLines: string[] = []
    try {
      if (isDir) {
        // rmR/rmdir are resolved lazily so object stores without a real
        // directory-remove op still unlink plain files (mirrors Python).
        if (recursive) {
          const listing = (dir: PathSpec): Promise<string[]> => ops.readdir(accessor, dir, idx)
          const probe = (spec: PathSpec): Promise<FileStat> => ops.stat(accessor, spec, idx)
          if (verbose) entryLines = removalLines(await cpWalk(listing, probe, p, idx), p)
          try {
            await rmR(accessor, p)
          } catch (err) {
            // The dispatcher declines a tree removal the caller's view
            // restricts: each entry's own removal is judged instead.
            if (ops.rmR === undefined || (err as { code?: string }).code !== 'ENOTSUP') throw err
            const { removed, failures } = await removeTree(p, {
              readdir: listing,
              stat: probe,
              unlink: (spec) => unlink(accessor, spec),
              rmdir: (spec) => rmdir(accessor, spec, idx),
              links,
            })
            entryLines = verbose ? removalLines(removed, p) : []
            for (const [entry, why] of failures) {
              errors.push(`rm: cannot remove '${entry.rawPath}': ${fsStrerror(why) ?? String(why)}`)
            }
            if (failures.length > 0) {
              if (verbose) lines.push(...entryLines)
              continue
            }
          }
          // A removal never crosses into a mount below, so it says so as
          // GNU's --one-file-system does.
          for (const root of mountPoints(opts.ns?.mounts, p.virtual))
            errors.push(
              `rm: skipping '${operandSpelling(root, p)}', since it's on a different device`,
            )
        } else if (dirFlag) {
          if ((await ops.readdir(accessor, p, idx)).length > 0) {
            errors.push(`rm: cannot remove '${p.rawPath}': Directory not empty`)
            continue
          }
          await rmdir(accessor, p, idx)
          entryLines = [`removed directory '${p.rawPath}'`]
        } else {
          errors.push(`rm: cannot remove '${p.rawPath}': Is a directory`)
          continue
        }
      } else {
        await unlink(accessor, p)
        entryLines = [`removed '${p.rawPath}'`]
      }
    } catch (err) {
      if (!isFsError(err)) throw err
      // GNU rm names the entry it could not remove (the guard blames
      // a read-only region below the operand by its anchor) and
      // keeps removing the rest.
      errors.push(
        `rm: cannot remove '${operandSpelling(errorVirtualPath(err), p)}': ${fsStrerror(err) ?? String(err)}`,
      )
      continue
    }
    if (verbose) lines.push(...entryLines)
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

export const BUILDER: GenericCommand = {
  name: 'rm',
  write: true,
  fn: rm,
}
