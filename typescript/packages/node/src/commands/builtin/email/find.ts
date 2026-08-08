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

import type { PathSpec } from '@struktoai/mirage-core'
import {
  ResourceName,
  command,
  findGeneric,
  resolveGlobOf,
  specOf,
  walkFind,
  type CommandFnResult,
  type CommandOpts,
} from '@struktoai/mirage-core'
import type { EmailAccessor } from '../../../accessor/email.ts'
import { readdir as emailReaddir } from '../../../core/email/readdir.ts'
import { stat as emailStat } from '../../../core/email/stat.ts'
import { EMAIL_IO } from './io.ts'
import { metadataProvision } from './provision.ts'

const resolveGlob = resolveGlobOf(EMAIL_IO)

// Routed through the shared generic walk instead of a bespoke tree walk:
// the generic owns every flag (-type, -size, -mtime, -empty, -path) and
// classifies entries through stat, so an attachment named report.pdf is a
// file and its like-named parent dir stays a directory. It also merges
// namespace symlinks, which no email readdir can see.
async function findCommand(
  accessor: EmailAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const idx = opts.index ?? undefined
  const resolved = await resolveGlob(accessor, paths, idx)
  const dirEmpty = async (spec: PathSpec): Promise<boolean> =>
    (await emailReaddir(accessor, spec, idx)).length === 0
  return findGeneric(
    resolved,
    texts,
    opts,
    (root, options) =>
      walkFind(
        root,
        {
          readdir: (spec, i) => emailReaddir(accessor, spec, i),
          stat: async (spec, i) => {
            const st = await emailStat(accessor, spec, i)
            return opts.statOverlay !== undefined ? opts.statOverlay(spec.virtual, st) : st
          },
          links: opts.links ?? null,
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
  resource: ResourceName.EMAIL,
  spec: specOf('find'),
  fn: findCommand,
  provision: metadataProvision,
})
