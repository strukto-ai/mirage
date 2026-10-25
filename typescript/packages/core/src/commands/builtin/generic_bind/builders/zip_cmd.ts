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

import type { FileStat, PathSpec } from '../../../../types.ts'
import { zipGeneric } from '../../generic/zip_cmd.ts'
import type { CommandFn } from '../../../config.ts'
import type { GenericCommand } from '../adapter.ts'
import { commandFiles, resolveOrEmpty } from '../files.ts'
import { walkOf } from '../archive_io.ts'
import { dispatchOf } from '../../utils/links.ts'

const zipCmd: CommandFn = async (_accessor, paths, _texts, ctx) => {
  const files = commandFiles(ctx, paths)
  const resolved = await resolveOrEmpty(files, paths)
  return zipGeneric(resolved, ctx, {
    stream: files.read,
    stat: async (p: PathSpec): Promise<FileStat> => files.stat(p),
    walk: walkOf(files, dispatchOf(ctx), 'zip'),
  })
}

export const BUILDER: GenericCommand = {
  name: 'zip',
  write: true,
  fn: zipCmd,
}
