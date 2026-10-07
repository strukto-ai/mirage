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
  type CommandIO,
  makeGenericCommands,
} from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { VFSName } from '@struktoai/mirage-core/types'

// Shell traversals need partial results and per-directory errors; the shared
// readdir/stat walker owns those. Direct VFS aggregate methods remain strict.
function walked(io: CommandIO): CommandIO {
  const rest = { ...io }
  delete rest.find
  delete rest.du
  return rest
}

export const DISK_COMMANDS: readonly RegisteredCommand[] = [
  ...makeGenericCommands(VFSName.DISK, { table: walked, local: true }),
]
