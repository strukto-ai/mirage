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
  specOf,
  type CommandFnResult,
  type CommandOpts,
  type PathSpec,
} from '@struktoai/mirage-core'
import { stat as opfsStat } from '../../../core/opfs/stat.ts'
import { unlink as opfsUnlink } from '../../../core/opfs/unlink.ts'
import type { OPFSAccessor } from '../../../accessor/opfs.ts'

async function unlinkCommand(
  accessor: OPFSAccessor,
  paths: PathSpec[],
  _texts: string[],
  _opts: CommandOpts,
): Promise<CommandFnResult> {
  const enc = new TextEncoder()
  if (paths.length === 0) {
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: enc.encode("unlink: missing operand\nTry 'unlink --help' for more information.\n"),
      }),
    ]
  }
  if (paths.length > 1) {
    const extra = paths[1]
    const raw = extra === undefined ? '' : extra.rawPath
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: enc.encode(
          `unlink: extra operand '${raw}'\nTry 'unlink --help' for more information.\n`,
        ),
      }),
    ]
  }
  const p = paths[0]
  if (p === undefined) return [null, new IOResult()]
  try {
    if ((await opfsStat(accessor, p)).type === FileType.DIRECTORY) {
      return [
        null,
        new IOResult({
          exitCode: 1,
          stderr: enc.encode(`unlink: cannot unlink '${p.virtual}': Is a directory\n`),
        }),
      ]
    }
  } catch {
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: enc.encode(`unlink: cannot unlink '${p.virtual}': No such file or directory\n`),
      }),
    ]
  }
  await opfsUnlink(accessor, p)
  return [null, new IOResult({ writes: { [p.mountPath]: new Uint8Array() } })]
}

export const OPFS_UNLINK = command({
  name: 'unlink',
  resource: ResourceName.OPFS,
  spec: specOf('unlink'),
  fn: unlinkCommand,
  write: true,
})
