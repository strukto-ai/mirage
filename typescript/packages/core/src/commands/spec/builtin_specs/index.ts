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

import type { CommandSpec } from '../types.ts'
import { SPECS as archive } from './archive.ts'
import { SPECS as fsMutate } from './fs_mutate.ts'
import { SPECS as hashing } from './hashing.ts'
import { SPECS as listing } from './listing.ts'
import { SPECS as net } from './net.ts'
import { SPECS as runtime } from './runtime.ts'
import { SPECS as search } from './search.ts'
import { SPECS as textProc } from './text_proc.ts'
import { SPECS as viewing } from './viewing.ts'

const MODULES = [archive, fsMutate, hashing, listing, net, runtime, search, textProc, viewing]

export const SPECS: Record<string, CommandSpec> = {}
for (const module of MODULES) {
  for (const name of Object.keys(module)) {
    if (name in SPECS) throw new Error(`duplicate command spec: ${name}`)
    SPECS[name] = module[name] as CommandSpec
  }
}
