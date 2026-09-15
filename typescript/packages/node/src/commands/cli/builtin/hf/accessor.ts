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
import { UsageError } from '@struktoai/mirage-core/commands/errors'
import type { FlagView } from '@struktoai/mirage-core/commands/spec/index'
import { IOResult } from '@struktoai/mirage-core/io/types'
import { yieldBytes } from '@struktoai/mirage-core/io/stream'
import type { ByteSource } from '@struktoai/mirage-core/io/types'
import { HfHubAccessor } from '../../../../accessor/hf_hub.ts'
import type { HfConfig } from '../../../../core/hf_hub/config.ts'
import { API_SEGMENTS, DEFAULT_REVISION } from '../../../../core/hf_hub/constants.ts'

const DEFAULT_REPO_TYPE = 'model'

/** The repo kind a line names, defaulting the way upstream does. */
export function repoTypeOf(fl: FlagView): string {
  const value = fl.asStr('repo_type') ?? DEFAULT_REPO_TYPE
  if (!(value in API_SEGMENTS)) throw new UsageError(`invalid repo type: ${value}`)
  return value
}

/**
 * A Hub handle for the repository this line named.
 *
 * The CLI builds one per invocation rather than owning a second Hub client:
 * an accessor is a value object here, holding the endpoint, the credential
 * and which repository is being addressed, so `hf` gets the mount's tree walk
 * and commit builder for free. It reaches no mount, which is what keeps this
 * an account CLI.
 */
export function hubFor(
  inv: CLIInvocation,
  repoId: string,
  repoType: string,
  revision?: string,
): HfHubAccessor {
  const config = inv.config as HfConfig
  return new HfHubAccessor(
    {
      repoId,
      ...(config.token !== undefined ? { token: config.token } : {}),
      endpoint: config.endpoint,
      revision: revision === undefined || revision === '' ? DEFAULT_REVISION : revision,
    },
    repoType,
  )
}

function result(text: string): [ByteSource, IOResult] {
  return [yieldBytes(new TextEncoder().encode(text)), new IOResult()]
}

/**
 * Refuse a line that left a required operand empty.
 *
 * `Operand.required` is inert outside the clap dialect on purpose: only clap
 * names the empty slots, and under every other style the refusal stays the
 * leaf's own business, worded by the command (`executor/command/cli.ts`). hf is
 * argparse, so each leaf that takes operands calls this, and it words the
 * refusal the way argparse does rather than letting the line reach the Hub and
 * come back as an authentication error.
 */
export function requireOperands(inv: CLIInvocation, names: readonly string[]): void {
  const missing = names.slice(inv.texts.length)
  if (missing.length > 0) {
    throw new UsageError(`the following arguments are required: ${missing.join(', ')}`)
  }
}

export function textOut(text: string): [ByteSource, IOResult] {
  return result(text)
}

/**
 * Refuse a verb that cannot work anonymously, before it is tried.
 *
 * The Hub answers 401 "Invalid username or password." for an unauthenticated
 * write, which reads as a wrong credential rather than as a missing one.
 */
export function requireToken(inv: CLIInvocation, what: string): void {
  const config = inv.config as HfConfig
  if (config.token === undefined || config.token === '') {
    throw new UsageError(`${what} requires a token; set \`token\` on the \`hf\` install`)
  }
}
