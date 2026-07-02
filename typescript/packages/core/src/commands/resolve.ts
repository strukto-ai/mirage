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

import { materialize as ioMaterialize } from '../io/types.ts'
import type { ByteSource } from '../io/types.ts'
import { OperandKind } from './spec/types.ts'
import type { CommandSpec } from './spec/types.ts'
import { lstripSlash } from '../utils/slash.ts'

export const COMPOUND_EXTENSIONS: ReadonlySet<string> = new Set([
  '.gdoc.json',
  '.gslide.json',
  '.gsheet.json',
  '.gmail.json',
])

export function getExtension(path: string | null): string | null {
  if (path === null) return null
  const basename = path.split('/').pop() ?? ''
  for (const ext of COMPOUND_EXTENSIONS) {
    if (basename.endsWith(ext)) return ext
  }
  const dot = path.lastIndexOf('.')
  if (dot === -1 || path.slice(dot).includes('/')) return null
  return path.slice(dot)
}

export async function materializeStdout(stdout: ByteSource | null): Promise<Uint8Array> {
  return ioMaterialize(stdout)
}

export function stripPrefixFromPathKwargs(
  kwargs: Record<string, string | boolean | string[]>,
  spec: CommandSpec,
  prefix: string,
): Record<string, string | boolean | string[]> {
  if (prefix === '') return kwargs
  const result: Record<string, string | boolean | string[]> = { ...kwargs }
  for (const opt of spec.options) {
    if (opt.valueKind !== OperandKind.PATH) continue
    for (const flagName of [opt.short, opt.long]) {
      if (flagName === null) continue
      const clean = flagName.replace(/^-+/, '')
      const val = result[clean]
      if (typeof val === 'string') {
        if (val.startsWith(`${prefix}/`) || val === prefix) {
          result[clean] = `/${lstripSlash(val.slice(prefix.length))}`
        }
      }
    }
  }
  return result
}
