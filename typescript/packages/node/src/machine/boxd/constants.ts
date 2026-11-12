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

const MACHINE_FIX = "create a machine and set the machine's machine_id to it"

/**
 * What a line on a machine that cannot take it says to do, by the state
 * boxd reports for it.
 */
export const MACHINE_GONE: Readonly<Record<string, string>> = {
  deleted: `it was deleted, never existed or is in another region; set the machine's region, or ${MACHINE_FIX}`,
  stopped: 'it was stopped; start it (`boxd machine start`) and run the line again',
  destroyed: `it was deleted, never existed or is in another region; set the machine's region, or ${MACHINE_FIX}`,
  failed: `it failed; ${MACHINE_FIX}`,
}
