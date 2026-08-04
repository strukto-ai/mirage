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
  FlagView,
  IOResult,
  type ByteSource,
  type CLIVerbOpts,
  type CommandFnResult,
  type PathSpec,
} from '@struktoai/mirage-core'
import { EmailAccessor } from '../../../../accessor/email.ts'
import { fetchMessage } from '../../../../core/email/_client.ts'
import { forwardMessage } from '../../../../core/email/send.ts'
import type { EmailConfig } from '../../../../core/email/config.ts'

const ENC = new TextEncoder()

export async function forward(
  config: unknown,
  _paths: PathSpec[],
  _texts: string[],
  opts: CLIVerbOpts,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags)
  const cfg = config as EmailConfig
  const accessor = new EmailAccessor(cfg)
  let original
  try {
    original = await fetchMessage(accessor, fl.asStr('folder') ?? '', fl.asStr('uid') ?? '')
  } finally {
    await accessor.close()
  }
  const result = await forwardMessage(cfg, original, fl.asStr('to') ?? '')
  const out: ByteSource = ENC.encode(JSON.stringify(result))
  return [out, new IOResult()]
}
