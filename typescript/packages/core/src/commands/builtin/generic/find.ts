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

import { isEnoent } from '../../../core/generic/find.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { FindOptions } from '../../../resource/base.ts'
import { parseFindExpression } from '../findParse.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { rebaseDisplay } from '../../../utils/path.ts'

const ENC = new TextEncoder()

export function invalidFindArg(value: string, flag: string): CommandFnResult {
  return [
    null,
    new IOResult({
      exitCode: 1,
      stderr: ENC.encode(`find: invalid argument '${value}' to '${flag}'\n`),
    }),
  ]
}

function parseSize(spec: string): [number | null, number | null] {
  const suffixes: Record<string, number> = { c: 1, k: 1024, M: 1024 ** 2, G: 1024 ** 3 }
  const sign = spec.startsWith('+') ? '+' : spec.startsWith('-') ? '-' : ''
  const raw = sign === '' ? spec : spec.slice(1)
  const lastChar = raw.slice(-1)
  const mult = suffixes[lastChar] ?? 1
  const numPart = lastChar in suffixes ? raw.slice(0, -1) : raw
  const num = Number.parseInt(numPart, 10) * mult
  if (sign === '+') return [num, null]
  if (sign === '-') return [null, num]
  return [num, num]
}

function parseMtime(spec: string): [number | null, number | null] {
  const now = Date.now() / 1000
  const day = 86_400
  const n = Number.parseInt(spec.replace(/^[+-]/, ''), 10)
  if (spec.startsWith('+')) return [null, now - n * day]
  if (spec.startsWith('-')) return [now - n * day, null]
  return [now - (n + 1) * day, now - n * day]
}

const nan = (v: number | null): boolean => v !== null && Number.isNaN(v)

// Reject malformed -size/-mtime on backends that do not implement those
// predicates, so a typo errors instead of being silently ignored. Returns the
// exit-1 result on bad input, else null.
export function findSizeMtimeError(
  sizeFlag: string | null,
  mtimeFlag: string | null,
): CommandFnResult | null {
  if (sizeFlag !== null) {
    const [lo, hi] = parseSize(sizeFlag)
    if (nan(lo) || nan(hi)) return invalidFindArg(sizeFlag, '-size')
  }
  if (mtimeFlag !== null) {
    const [lo, hi] = parseMtime(mtimeFlag)
    if (nan(lo) || nan(hi)) return invalidFindArg(mtimeFlag, '-mtime')
  }
  return null
}

function extractNotName(texts: readonly string[]): string | null {
  for (let i = 0; i < texts.length; i++) {
    const pat = texts[i + 2]
    if (texts[i] === '-not' && texts[i + 1] === '-name' && pat !== undefined) {
      return pat
    }
  }
  return null
}

function extractOrNames(name: string | null, texts: readonly string[]): string[] {
  const names: string[] = []
  if (name !== null) names.push(name)
  let i = 0
  while (i < texts.length) {
    const pat = texts[i + 2]
    const isOr = texts[i] === '-or' || texts[i] === '-o'
    if (isOr && texts[i + 1] === '-name' && pat !== undefined) {
      names.push(pat)
      i += 3
    } else {
      i += 1
    }
  }
  return names
}

export async function findGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  find: (root: PathSpec, options: FindOptions) => Promise<string[]>,
): Promise<CommandFnResult> {
  const nameFlag = typeof opts.flags.name === 'string' ? opts.flags.name : null
  const inameFlag = typeof opts.flags.iname === 'string' ? opts.flags.iname : null
  const typeFlag = typeof opts.flags.type === 'string' ? opts.flags.type : null
  const pathFlag = typeof opts.flags.path === 'string' ? opts.flags.path : null
  const maxDepthFlag = typeof opts.flags.maxdepth === 'string' ? opts.flags.maxdepth : null
  const minDepthFlag = typeof opts.flags.mindepth === 'string' ? opts.flags.mindepth : null
  const sizeFlag = typeof opts.flags.size === 'string' ? opts.flags.size : null
  const mtimeFlag = typeof opts.flags.mtime === 'string' ? opts.flags.mtime : null
  const targets =
    paths.length > 0
      ? paths
      : [
          new PathSpec({
            resourcePath: '',
            virtual: '/',
            directory: '/',
            resolved: false,
          }),
        ]
  const findType: 'f' | 'd' | null = typeFlag === 'f' ? 'f' : typeFlag === 'd' ? 'd' : null
  const maxDepth = maxDepthFlag !== null ? Number.parseInt(maxDepthFlag, 10) : null
  const minDepth = minDepthFlag !== null ? Number.parseInt(minDepthFlag, 10) : null
  const [minSize, maxSize] = sizeFlag !== null ? parseSize(sizeFlag) : [null, null]
  const [mtimeMin, mtimeMax] = mtimeFlag !== null ? parseMtime(mtimeFlag) : [null, null]
  const isNan = (v: number | null): boolean => v !== null && Number.isNaN(v)
  let badArg: readonly [string, string] | null = null
  if (maxDepthFlag !== null && isNan(maxDepth)) badArg = [maxDepthFlag, '-maxdepth']
  else if (minDepthFlag !== null && isNan(minDepth)) badArg = [minDepthFlag, '-mindepth']
  else if (sizeFlag !== null && (isNan(minSize) || isNan(maxSize))) badArg = [sizeFlag, '-size']
  else if (mtimeFlag !== null && (isNan(mtimeMin) || isNan(mtimeMax)))
    badArg = [mtimeFlag, '-mtime']
  if (badArg !== null) return invalidFindArg(badArg[0], badArg[1])
  const nameExclude = extractNotName(texts)
  const orNames = extractOrNames(nameFlag, texts)
  const emptyFlag = opts.flags.empty === true
  const expr = texts.length > 0 ? parseFindExpression(texts) : null
  const options: FindOptions =
    expr !== null
      ? {
          tree: expr.tree,
          ...(expr.maxDepth !== null ? { maxDepth: expr.maxDepth } : {}),
          ...(expr.minDepth !== null ? { minDepth: expr.minDepth } : {}),
          ...(expr.minSize !== null ? { minSize: expr.minSize } : {}),
          ...(expr.maxSize !== null ? { maxSize: expr.maxSize } : {}),
          ...(expr.mtimeMin !== null ? { mtimeMin: expr.mtimeMin } : {}),
          ...(expr.mtimeMax !== null ? { mtimeMax: expr.mtimeMax } : {}),
          ...(expr.usesEmpty ? { empty: true } : {}),
        }
      : {
          name: nameFlag,
          iname: inameFlag,
          type: findType,
          ...(maxDepth !== null ? { maxDepth } : {}),
          ...(minDepth !== null ? { minDepth } : {}),
          ...(minSize !== null ? { minSize } : {}),
          ...(maxSize !== null ? { maxSize } : {}),
          ...(mtimeMin !== null ? { mtimeMin } : {}),
          ...(mtimeMax !== null ? { mtimeMax } : {}),
          ...(nameExclude !== null ? { nameExclude } : {}),
          ...(pathFlag !== null ? { pathPattern: pathFlag } : {}),
          ...(orNames.length > 1 ? { orNames } : {}),
          ...(emptyFlag ? { empty: true } : {}),
        }
  const matches: string[] = []
  for (const root of targets) {
    let keys: string[]
    try {
      keys = await find(root, options)
    } catch (err) {
      // GNU find reports missing roots and moves on; anything else
      // (rate limits, auth failures) must surface.
      if (isEnoent(err)) continue
      throw err
    }
    const rootKey = rstripSlash(root.mountPath) || '/'
    const rootMatches: string[] = []
    for (const key of keys) {
      const displayPath =
        root.virtual === '/'
          ? key
          : rootKey === '/' && key === '/'
            ? rstripSlash(root.virtual)
            : rstripSlash(root.virtual) + key.slice(rootKey === '/' ? 0 : rootKey.length)
      rootMatches.push(displayPath)
    }
    matches.push(...rebaseDisplay(rootMatches, root.virtual, root.display))
  }
  matches.sort()
  const out: ByteSource = ENC.encode(matches.length ? matches.join('\n') + '\n' : '')
  return [out, new IOResult()]
}
