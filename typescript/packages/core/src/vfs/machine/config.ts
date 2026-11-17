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

import { z } from 'zod'
import type { ConfigOf } from '../secrets.ts'

export const MachineVFSConfig = z.object({
  machines: z
    .array(z.string())
    .optional()
    .describe(
      "The machines whose files the mount shows, by their `machines:` names; unset shows every machine's.",
    ),
  root: z
    .string()
    .optional()
    .meta({ description: 'The path on each machine that becomes the mount root.', default: '/' }),
  defaultMachine: z
    .string()
    .optional()
    .describe(
      'Where a new name lands when the command writing it runs no program on a machine; unset is the machine that runs the programs nothing in Mirage resolves, else the first.',
    ),
})

export type MachineVFSConfig = ConfigOf<typeof MachineVFSConfig>
