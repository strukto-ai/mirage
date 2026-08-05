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
  type CLIVerbOpts,
  type CommandFnResult,
  type PathSpec,
} from '@struktoai/mirage-core'
import type { EmailConfig } from '../../../../core/email/config.ts'
import { route } from './util.ts'

export async function compose(
  config: unknown,
  _paths: PathSpec[],
  _texts: string[],
  opts: CLIVerbOpts,
): Promise<CommandFnResult> {
  return route(config as EmailConfig, new FlagView(opts.flags), opts.stdin, null)
}
