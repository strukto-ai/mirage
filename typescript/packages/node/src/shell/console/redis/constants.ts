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

import { readFileSync } from 'node:fs'

// INCR hands out the dense seq and XADD stores the chunk under the
// stream id `(seq+1)-0` in one atomic step, so two appends racing (a
// kill marker against a runner's last emit) cannot collide on an id.
// Shipped next to this module in src and copied beside the bundle in
// dist (tsup onSuccess); byte-identical to the Python append.lua.
export const APPEND_LUA = readFileSync(new URL('./append.lua', import.meta.url), 'utf8')

export const POLL_MS = 100
