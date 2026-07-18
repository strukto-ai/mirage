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

import { rekey } from '../../../utils/key_prefix.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { PathSpec, type MoveStrategy, type PrimitiveMove, type StatFn } from '../../../types.ts'
import {
  backendKeyDefault,
  copyTargets,
  isDirectory,
  pathExists,
  type BackendKeyFn,
} from '../utils/copy.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { cpWalk } from './cp.ts'

const ENC = new TextEncoder()

function isPrimitiveMove(strategy: MoveStrategy): strategy is PrimitiveMove {
  return 'readBytes' in strategy
}

export async function mvGeneric(
  paths: PathSpec[],
  stat: StatFn,
  strategy: MoveStrategy,
  noClobber: boolean,
  verbose: boolean,
  index?: IndexCacheStore,
  backendKey?: BackendKeyFn,
): Promise<[ByteSource | null, IOResult]> {
  const keyOf = backendKey ?? backendKeyDefault
  const sources = paths.slice(0, -1)
  const dst = paths[paths.length - 1]
  if (dst === undefined) return [null, new IOResult()]
  const dstIsDir = await isDirectory(stat, dst, index)
  const writes: Record<string, ByteSource> = {}
  const lines: string[] = []
  const errors: string[] = []
  for (const [src, target] of copyTargets(sources, dst, dstIsDir)) {
    if (!(await pathExists(stat, src))) {
      errors.push(`mv: cannot stat '${src.virtual}': No such file or directory`)
      continue
    }
    if (keyOf(src) === keyOf(target)) {
      errors.push(`mv: '${src.virtual}' and '${target.virtual}' are the same file`)
      continue
    }
    if (keyOf(target).startsWith(keyOf(src) + '/')) {
      errors.push(
        `mv: cannot move '${src.virtual}' to a subdirectory of itself, '${target.virtual}'`,
      )
      continue
    }
    if (noClobber && (await pathExists(stat, target))) continue
    if (isPrimitiveMove(strategy)) {
      const srcBase = rstripSlash(src.mountPath)
      const dstBase = rstripSlash(target.mountPath)
      const entries = await cpWalk(strategy.readdir, stat, src, index)
      for (const { path: entry, isDir } of entries) {
        const entryDst = dstBase + entry.slice(srcBase.length)
        const entryDstSpec = PathSpec.fromStrPath(entryDst)
        if (isDir) {
          if (!(await isDirectory(stat, entryDstSpec, index))) await strategy.mkdir(entryDstSpec)
        } else {
          await strategy.write(entryDstSpec, await strategy.readBytes(PathSpec.fromStrPath(entry)))
        }
      }
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const node = entries[i]
        if (node === undefined) continue
        const spec = PathSpec.fromStrPath(
          node.path,
          rekey(src.virtual, src.resourcePath, node.path),
        )
        if (node.isDir) await strategy.rmdir(spec)
        else await strategy.unlink(spec)
      }
    } else {
      await strategy.rename(src, target)
    }
    writes[src.mountPath] = new Uint8Array()
    writes[target.mountPath] = new Uint8Array()
    if (verbose) lines.push(`'${src.virtual}' -> '${target.virtual}'`)
  }
  const output: ByteSource | null = lines.length > 0 ? ENC.encode(lines.join('\n') + '\n') : null
  const stderr = errors.length > 0 ? ENC.encode(errors.join('\n') + '\n') : null
  return [output, new IOResult({ writes, stderr, exitCode: errors.length > 0 ? 1 : 0 })]
}
