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

import type { RAMAccessor } from '../../../accessor/ram.ts'
import { readStream } from '../../../core/dev/stream.ts'
import { VFSName } from '../../../types.ts'
import type { Command, CommandIO } from '../../config.ts'
import { genericCommands } from '../generic_bind/index.ts'

function endless(io: CommandIO): CommandIO {
  return {
    ...io,
    readStream: (accessor, path, index) => readStream(accessor as RAMAccessor, path, index),
  }
}

// /dev is a RAM mount whose read and stat know the two synthetic character
// devices. Commands that consume a whole input read a finite stream, while
// the two bounded streaming commands opt into the endless source.
export const DEV_COMMANDS: readonly Command[] = [
  ...genericCommands(VFSName.RAM, { adapt: { cat: endless, head: endless }, local: true }),
]
