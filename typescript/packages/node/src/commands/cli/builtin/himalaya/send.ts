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
import { sendMessage } from '../../../../core/email/send.ts'
import type { EmailConfig } from '../../../../resource/email/config.ts'

const ENC = new TextEncoder()

export async function send(
  config: unknown,
  _paths: PathSpec[],
  _texts: string[],
  opts: CLIVerbOpts,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags)
  const result = await sendMessage(
    config as EmailConfig,
    fl.asStr('to') ?? '',
    fl.asStr('subject') ?? '',
    fl.asStr('body') ?? '',
  )
  const out: ByteSource = ENC.encode(JSON.stringify(result))
  return [out, new IOResult()]
}
