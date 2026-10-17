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
import { FlagView } from '@struktoai/mirage-core/commands/spec/index'
import type { EmailAccessor } from '../../../../accessor/email.ts'
import { route } from './util.ts'

export async function compose(
  accessor: EmailAccessor,
  _paths: PathSpec[],
  _texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  return route(accessor, new FlagView(ctx.flags), ctx.stdin, null, ctx.vfs)
}
