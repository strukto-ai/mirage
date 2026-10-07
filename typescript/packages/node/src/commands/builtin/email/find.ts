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

import { findGeneric } from '@struktoai/mirage-core/commands/builtin/generic/find'
import type {
  Builder,
  CommandIO,
} from '@struktoai/mirage-core/commands/builtin/generic_bind/adapter'
import { findWalk } from '@struktoai/mirage-core/commands/builtin/generic_bind/builders/find'
import { resolveGlobOf } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import type { CommandFnResult, CommandOpts } from '@struktoai/mirage-core/commands/config'
import { walkFind } from '@struktoai/mirage-core/core/generic/find'
import { pathsScoped } from '@struktoai/mirage-core/ops/namespace_view'
import { PathSpec } from '@struktoai/mirage-core/types'
import type { EmailAccessor } from '../../../accessor/email.ts'

// Routed through the shared generic walk instead of a bespoke tree walk:
// the generic owns every flag (-type, -size, -mtime, -empty, -path) and
// classifies entries through stat, so an attachment named report.pdf is a
// file and its like-named parent dir stays a directory. It also merges
// namespace symlinks, which no email readdir can see.
async function find(
  ops: CommandIO<EmailAccessor>,
  accessor: EmailAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const idx = opts.index ?? undefined
  const scoped = pathsScoped(opts.ns, [PathSpec.fromStrPath((opts.mountPrefix ?? '') || '/')])
  const resolved = await resolveGlobOf(ops)(accessor, paths, idx)
  // Under a hide or a rule the walk is the generic builder's, which names
  // an entry it cannot open where GNU find does.
  if (scoped) return findWalk(ops, accessor, resolved, texts, opts)
  const dirEmpty = async (spec: PathSpec): Promise<boolean> =>
    (await ops.readdir(accessor, spec, idx)).length === 0
  return findGeneric(
    resolved,
    texts,
    opts,
    (root, options) =>
      walkFind(
        root,
        {
          readdir: (spec, i) => ops.readdir(accessor, spec, i),
          stat: async (spec, i) => {
            const st = await ops.stat(accessor, spec, i)
            const overlay = opts.ns?.statOverlay
            return overlay !== undefined ? overlay(spec.virtual, st) : st
          },
          links: opts.ns?.links ?? null,
        },
        options,
        idx,
      ),
    undefined,
    dirEmpty,
  )
}

export const BUILDER: Builder<EmailAccessor> = {
  name: 'find',
  fn: find,
}
