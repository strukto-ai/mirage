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
  IOResult,
  ResourceName,
  command,
  fsStrerror,
  isFsError,
  specOf,
  type CommandFnResult,
  type CommandOpts,
  type PathSpec,
} from '@struktoai/mirage-core'
import { writeBytes as opfsWrite } from '../../../core/opfs/write.ts'
import { exists as opfsExists } from '../../../core/opfs/exists.ts'
import type { OPFSAccessor } from '../../../accessor/opfs.ts'

const ENC = new TextEncoder()

async function touchCommand(
  accessor: OPFSAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  if (paths.length === 0) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('touch: missing operand\n') })]
  }
  const createOnly = opts.flags.c === true
  const errors: string[] = []
  for (const p of paths) {
    if (createOnly) continue
    if (await opfsExists(accessor, p)) continue
    try {
      await opfsWrite(accessor, p, new Uint8Array(0))
    } catch (err) {
      // Mirrors the generic builder: one unusable operand is reported and
      // the rest still get touched.
      if (!isFsError(err)) throw err
      errors.push(`touch: cannot touch '${p.virtual}': ${String(fsStrerror(err))}`)
    }
  }
  const stderr = errors.length > 0 ? ENC.encode(errors.join('\n') + '\n') : null
  return [null, new IOResult({ stderr, exitCode: errors.length > 0 ? 1 : 0 })]
}

export const OPFS_TOUCH = command({
  name: 'touch',
  resource: ResourceName.OPFS,
  spec: specOf('touch'),
  fn: touchCommand,
  write: true,
})
