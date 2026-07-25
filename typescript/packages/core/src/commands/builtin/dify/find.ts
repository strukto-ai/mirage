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

import { mountPrefixOf } from '../../../utils/key_prefix.ts'
import type { DifyAccessor } from '../../../accessor/dify.ts'
import { find as difyFind } from '../../../core/dify/find.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { DIFY_IO } from './io.ts'
import { materialize, type ByteSource } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { findGeneric } from '../generic/find.ts'

const resolveGlob = resolveGlobOf(DIFY_IO)

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function defaultName(
  flags: Record<string, string | boolean | string[]>,
  texts: readonly string[],
): Record<string, string | boolean | string[]> {
  if (typeof flags.name === 'string') return flags
  const first = texts[0]
  if (first !== undefined && !first.startsWith('-') && !['(', ')', '!'].includes(first)) {
    return { ...flags, name: first }
  }
  return flags
}

async function normalizeFindOutput(
  stdout: ByteSource | null,
  searchPath: PathSpec,
): Promise<ByteSource | null> {
  if (stdout === null) return null
  const data = await materialize(stdout)
  const root =
    rstripSlash(mountPrefixOf(searchPath.virtual, searchPath.resourcePath)) !== ''
      ? rstripSlash(mountPrefixOf(searchPath.virtual, searchPath.resourcePath))
      : '/'
  const text = DEC.decode(data)
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n')
  const normalized = lines.map((line) => (line === root + '/' ? root : line))
  if (normalized.length === 0) return new Uint8Array(0)
  return ENC.encode(normalized.join('\n') + '\n')
}

async function findCommand(
  accessor: DifyAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const index = opts.index ?? undefined
  const resolved = paths.length > 0 ? await resolveGlob(accessor, paths, index) : []
  const searchPath = resolved[0]
  const adjustedOpts: CommandOpts = { ...opts, flags: defaultName(opts.flags, texts) }
  const result = await findGeneric(resolved, texts, adjustedOpts, (root, options) =>
    difyFind(accessor, root, options, index),
  )
  if (result === null || searchPath === undefined) return result
  const [stdout, io] = result
  return [await normalizeFindOutput(stdout, searchPath), io]
}

export const DIFY_FIND = command({
  name: 'find',
  resource: ResourceName.DIFY,
  spec: specOf('find'),
  fn: findCommand,
})
