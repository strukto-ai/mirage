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

export interface LostCode {
  name: string
  code: string
  status: number
  lost: boolean
}

/** integ/fixtures/write/lost_codes.json, shared with the python suite. */
export const LOST_CODES = JSON.parse(
  readFileSync(
    new URL('../../../../../../integ/fixtures/write/lost_codes.json', import.meta.url),
    'utf-8',
  ),
) as { cases: LostCode[]; matched: LostCode[] }

/** An SDK error named `name` with HTTP status `status`. */
export function sdkError(name: string, status: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } })
}
