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

import { cachedPrefixBytes } from '../../../cache/read_through.ts'
import type { DatabricksVolumeAccessor } from '../../../accessor/databricks_volume.ts'
import { resolveGlob } from '../../../core/databricks_volume/glob.ts'
import { stat as dbxStat } from '../../../core/databricks_volume/stat.ts'
import { rangeRead, readStream as dbxStream } from '../../../core/databricks_volume/stream.ts'
import { type FileStat, ResourceName, type PathSpec } from '../../../types.ts'
import { IOResult } from '../../../io/types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { headGeneric } from '../generic/head.ts'
import { headTailProvision } from './provision.ts'

async function headCommand(
  accessor: DatabricksVolumeAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const index = opts.index ?? undefined
  const resolved = paths.length > 0 ? await resolveGlob(accessor, paths, index) : []
  const cRaw = typeof opts.flags.c === 'string' ? opts.flags.c : null
  const cInt = cRaw !== null ? Number.parseInt(cRaw, 10) : null
  const single = resolved[0]
  // Single file with -c >= 0: serve the first cInt bytes from the cache
  // when warm, else fetch only those bytes via a range request instead of
  // streaming the whole file.
  if (resolved.length === 1 && single !== undefined && cInt !== null && cInt >= 0) {
    const data =
      (await cachedPrefixBytes(single, cInt)) ?? (await rangeRead(accessor, single, 0, cInt))
    return [data, new IOResult()]
  }
  const stat = (p: PathSpec): Promise<FileStat> => dbxStat(accessor, p, index)
  return headGeneric(resolved, texts, opts, stat, (p) => dbxStream(accessor, p))
}

export const DATABRICKS_VOLUME_HEAD = command({
  name: 'head',
  resource: ResourceName.DATABRICKS_VOLUME,
  spec: specOf('head'),
  fn: headCommand,
  provision: headTailProvision,
})
