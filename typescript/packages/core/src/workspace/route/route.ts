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

import type { MountRegistry } from '../mount/registry.ts'
import type { Session } from '../session/session.ts'
import { NAMESPACE_COMMANDS, SHELL_NAMES } from './constants.ts'
import { Consumer } from './types.ts'

/**
 * Route a command name to the layer that consumes it.
 *
 * Order mirrors dispatch precedence: shell builtins shadow functions,
 * functions shadow mount commands, and a name nobody registers is
 * UNKNOWN (command not found).
 */
export function route(name: string, session: Session, registry: MountRegistry): Consumer {
  if (SHELL_NAMES.has(name)) return Consumer.SESSION
  if (NAMESPACE_COMMANDS.has(name)) return Consumer.NAMESPACE
  if (name in session.functions) return Consumer.FUNCTION
  if (registry.mountForCommand(name) !== null) return Consumer.MOUNT
  return Consumer.UNKNOWN
}
