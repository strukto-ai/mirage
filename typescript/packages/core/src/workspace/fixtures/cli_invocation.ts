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

import type { CLIInvocation } from '../../commands/cli/types.ts'
import { ROOT_CWD } from '../../commands/constants.ts'
import { PathSpec } from '../../types.ts'

/**
 * A CLI invocation for a handler test. Every field the test leaves out takes
 * the default Python's `CLIInvocation` dataclass gives it.
 */
export function cliInvocation<ConfigT>(
  fields: Partial<CLIInvocation<ConfigT>> & { config: ConfigT },
): CLIInvocation<ConfigT> {
  return {
    argv: [],
    paths: [],
    texts: [],
    flags: {},
    stdin: null,
    cwd: PathSpec.fromStrPath(ROOT_CWD),
    env: {},
    ...fields,
  }
}
