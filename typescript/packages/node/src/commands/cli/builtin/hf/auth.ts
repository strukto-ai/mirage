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

import type { CLIInvocation } from '@struktoai/mirage-core/commands/cli/types'
import type { CommandFnResult } from '@struktoai/mirage-core/commands/config'
import { whoami } from '../../../../core/hf_hub/account.ts'
import { API_BASE } from '../../../../core/hf_hub/constants.ts'
import { hfEndpoint, type HfConfig } from '../../../../core/hf_hub/config.ts'
import { requireToken, textOut } from './accessor.ts'

/** Print the account the configured token belongs to. */
export async function whoamiCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  requireToken(inv, 'auth whoami')
  const account = await whoami(inv.config as HfConfig)
  const lines = [typeof account.name === 'string' ? account.name : '']
  const orgs = account.orgs
  const members: string[] = []
  for (const org of Array.isArray(orgs) ? orgs : []) {
    if (typeof org === 'object' && org !== null) {
      const name = (org as { name?: unknown }).name
      if (typeof name === 'string') members.push(name)
    }
  }
  // `orgs: ` and not a bare line each, which is upstream's shape --
  // `print(ANSI.bold("orgs: "), ",".join(orgs))` in commands/user.py, whose
  // two arguments put a second space after the colon. Unlabelled, the account
  // and the organizations it belongs to are indistinguishable, and a reader
  // taking the last line pushes to the org instead of the user. Measured: an
  // agent asked to create a repo under its own account read the org off the
  // second line and created it there, which the Hub accepts and a grader
  // looking under the account does not find.
  //
  // The escape codes upstream wraps the label in are NOT reproduced. They are
  // a terminal's, not the command's, and NO_COLOR strips them there too; what
  // has to match is the word.
  if (members.length > 0) lines.push(`orgs:  ${members.join(',')}`)
  // Upstream prints this whenever the endpoint is not huggingface.co, which
  // for every mirage install is always: the endpoint is the deployment's.
  //
  // Read through hfEndpoint and not off the config, because that is what the
  // REQUEST used: an empty endpoint means the public Hub there, and comparing
  // the raw value would announce a private endpoint with no origin after it
  // for a request that went to huggingface.co.
  const endpoint = hfEndpoint(inv.config as HfConfig).replace(/\/+$/, '')
  if (endpoint !== API_BASE) {
    lines.push(`Authenticated through private endpoint: ${endpoint}`)
  }
  return textOut(`${lines.join('\n')}\n`)
}

/**
 * List the stored access tokens.
 *
 * A workspace has no token store: an install carries exactly one credential,
 * given to it by the embedding program. So this reports that one under
 * upstream's own two-column shape rather than pretending to a set it cannot
 * hold, and reports nothing when there is none.
 */
export async function listCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  const config = inv.config as HfConfig
  const rows = ['NAME'.padEnd(20) + ' ' + 'TOKEN']
  if (config.token !== undefined && config.token !== '') {
    const account = await whoami(config)
    const name = typeof account.name === 'string' ? account.name : 'install'
    rows.push(name.padEnd(20) + ' ' + '*'.repeat(8))
  }
  return textOut(`${rows.join('\n')}\n`)
}
