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
import { findWalk } from '@struktoai/mirage-core/commands/builtin/generic_bind/builders/find'
import { resolveGlobOf, scanIo } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import { command } from '@struktoai/mirage-core/commands/config'
import type { CommandFnResult, CommandOpts } from '@struktoai/mirage-core/commands/config'
import { specOf } from '@struktoai/mirage-core/commands/spec/index'
import { walkFind } from '@struktoai/mirage-core/core/generic/find'
import { VFSName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import type { EmailAccessor } from '../../../accessor/email.ts'
import { IO } from './io.ts'

// Routed through the shared generic walk instead of a bespoke tree walk:
// the generic owns every flag (-type, -size, -mtime, -empty, -path) and
// classifies entries through stat, so an attachment named report.pdf is a
// file and its like-named parent dir stays a directory. It also merges
// namespace symlinks, which no email readdir can see.
async function find(
  accessor: EmailAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const idx = opts.index ?? undefined
  const [scan, scoped] = scanIo(IO, opts.ns, opts.mountPrefix)
  const resolved = await resolveGlobOf(scan)(accessor, paths, idx)
  // Under a hide or a rule the walk is the generic builder's, which names
  // an entry it cannot open where GNU find does.
  if (scoped) return findWalk(scan, accessor, resolved, texts, opts)
  const dirEmpty = async (spec: PathSpec): Promise<boolean> =>
    (await scan.readdir(accessor, spec, idx)).length === 0
  return findGeneric(
    resolved,
    texts,
    opts,
    (root, options) =>
      walkFind(
        root,
        {
          readdir: (spec, i) => scan.readdir(accessor, spec, i),
          stat: async (spec, i) => {
            const st = await scan.stat(accessor, spec, i)
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

export const EMAIL_FIND = command({
  name: 'find',
  vfs: VFSName.EMAIL,
  spec: specOf('find'),
  fn: find,
})
