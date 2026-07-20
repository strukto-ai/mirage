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

import {
  FileType,
  IOResult,
  ResourceName,
  command,
  cpWalk,
  formatRecords,
  removalLines,
  resolveGlobOf,
  specOf,
  writeMetadataProvision,
  type ByteSource,
  type CommandFnResult,
  type CommandOpts,
  type PathSpec,
} from '@struktoai/mirage-core'
import type { GridFSAccessor } from '../../../accessor/gridfs.ts'
import { readdir as gridfsReaddir } from '../../../core/gridfs/readdir.ts'
import { rmR as gridfsRmR } from '../../../core/gridfs/rm.ts'
import { rmdir as gridfsRmdir } from '../../../core/gridfs/rmdir.ts'
import { stat as gridfsStat } from '../../../core/gridfs/stat.ts'
import { unlink as gridfsUnlink } from '../../../core/gridfs/unlink.ts'
import { GRIDFS_IO } from './io.ts'

const resolveGlob = resolveGlobOf(GRIDFS_IO)

const ENC = new TextEncoder()

interface RmOpts {
  recursive: boolean
  force: boolean
  removeDir: boolean
  verbose: boolean
}

// Remove one operand, returning a GNU stderr line on failure (null when
// removed, or skipped under -f) alongside the verbose lines.
async function rmOne(
  accessor: GridFSAccessor,
  path: PathSpec,
  opts: RmOpts,
  index: CommandOpts['index'],
): Promise<[string | null, string[]]> {
  const label = path.virtual
  let isDir = false
  try {
    const st = await gridfsStat(accessor, path, index ?? undefined)
    isDir = st.type === FileType.DIRECTORY
  } catch {
    if (opts.force) return [null, []]
    return [`rm: cannot remove '${label}': No such file or directory`, []]
  }
  if (isDir) {
    if (opts.recursive) {
      const lines = opts.verbose
        ? removalLines(
            await cpWalk(
              (dir) => gridfsReaddir(accessor, dir, index ?? undefined),
              (spec) => gridfsStat(accessor, spec, index ?? undefined),
              path,
              index ?? undefined,
            ),
          )
        : []
      await gridfsRmR(accessor, path)
      return [null, lines]
    }
    if (opts.removeDir) {
      const children = await gridfsReaddir(accessor, path, index ?? undefined)
      if (children.length > 0) {
        return [`rm: cannot remove '${label}': Directory not empty`, []]
      }
      await gridfsRmdir(accessor, path)
      return [null, opts.verbose ? [`removed directory '${label}'`] : []]
    }
    return [`rm: cannot remove '${label}': Is a directory`, []]
  }
  await gridfsUnlink(accessor, path)
  return [null, opts.verbose ? [`removed '${label}'`] : []]
}

async function rmCommand(
  accessor: GridFSAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  if (paths.length === 0) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('rm: missing operand\n') })]
  }
  const resolved = await resolveGlob(accessor, paths, opts.index ?? undefined)
  const recursive = opts.flags.r === true || opts.flags.R === true
  const force = opts.flags.f === true
  const removeDir = opts.flags.d === true
  const verbose = opts.flags.v === true
  const verboseParts: string[] = []
  const errors: string[] = []
  const writes: Record<string, Uint8Array> = {}
  for (const p of resolved) {
    // GNU rm reports the operand and keeps removing the rest.
    const [error, entryLines] = await rmOne(
      accessor,
      p,
      { recursive, force, removeDir, verbose },
      opts.index,
    )
    if (error !== null) {
      errors.push(error)
      continue
    }
    writes[p.mountPath] = new Uint8Array()
    if (verbose) verboseParts.push(...entryLines)
  }
  const output: ByteSource | null = verbose ? formatRecords(verboseParts) : null
  const stderr = errors.length > 0 ? ENC.encode(errors.join('\n') + '\n') : undefined
  return [
    output,
    new IOResult({
      writes,
      exitCode: errors.length > 0 ? 1 : 0,
      ...(stderr !== undefined ? { stderr } : {}),
    }),
  ]
}

export const GRIDFS_RM = command({
  name: 'rm',
  resource: ResourceName.GRIDFS,
  spec: specOf('rm'),
  fn: rmCommand,
  write: true,
  provision: writeMetadataProvision,
})
