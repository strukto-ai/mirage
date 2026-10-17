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

import type { CommandFnResult, Context } from '@struktoai/mirage-core/commands/config'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { VERSION } from '@struktoai/mirage-core/version'
import type { HfAccountAccessor } from '../../../../accessor/hf_hub.ts'
import { textOut } from './accessor.ts'

/**
 * Print what this install is pointed at.
 *
 * Upstream prints the local machine's python, platform and cache layout. None
 * of those describe what an agent is talking to, and two of them do not exist
 * in a workspace, so this reports the facts that do.
 */
export function envCmd(
  accessor: HfAccountAccessor,
  _paths: PathSpec[],
  _texts: string[],
  _ctx: Context,
): CommandFnResult {
  const token = accessor.token !== undefined && accessor.token !== '' ? 'set' : 'not set'
  return textOut(
    [
      '- huggingface_hub version: mirage',
      `- mirage version: ${VERSION}`,
      `- endpoint: ${accessor.endpoint}`,
      `- token: ${token}`,
    ].join('\n') + '\n',
  )
}

export function versionCmd(
  _accessor: HfAccountAccessor,
  _paths: PathSpec[],
  _texts: string[],
  _ctx: Context,
): CommandFnResult {
  return textOut(`hf version ${VERSION} (mirage)\n`)
}
