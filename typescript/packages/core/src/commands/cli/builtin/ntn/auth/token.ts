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

import { IOResult } from '../../../../../io/types.ts'
import type { CommandFnResult, Context } from '../../../../config.ts'
import type { PathSpec } from '../../../../../types.ts'
import type { NtnAccessor } from '../util.ts'

const ENC = new TextEncoder()
const REFUSED =
  'error: The authentication token stays in Mirage configuration and is never printed.\n' +
  '  hint: ntn commands use it directly.\n'

export function token(
  _accessor: NtnAccessor,
  _paths: PathSpec[],
  _texts: string[],
  _ctx: Context,
): CommandFnResult {
  return [null, new IOResult({ stderr: ENC.encode(REFUSED), exitCode: 1 })]
}
