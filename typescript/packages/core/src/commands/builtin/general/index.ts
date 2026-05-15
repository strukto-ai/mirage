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

import type { RegisteredCommand } from '../../config.ts'
import { GENERAL_BC } from './bc.ts'
import { GENERAL_CURL } from './curl.ts'
import { GENERAL_DATE } from './date.ts'
import { GENERAL_EXPR } from './expr.ts'
import { GENERAL_HISTORY } from './history.ts'
import { GENERAL_PYTHON, GENERAL_PYTHON3 } from './python.ts'
import { GENERAL_SEQ } from './seq.ts'
import { GENERAL_SLEEP } from './sleep.ts'
import { GENERAL_WGET } from './wget.ts'

export { GENERAL_BC } from './bc.ts'
export { GENERAL_CURL } from './curl.ts'
export { GENERAL_DATE } from './date.ts'
export { GENERAL_EXPR } from './expr.ts'
export { GENERAL_HISTORY } from './history.ts'
export { GENERAL_PYTHON, GENERAL_PYTHON3 } from './python.ts'
export { GENERAL_SEQ } from './seq.ts'
export { GENERAL_SLEEP } from './sleep.ts'
export { GENERAL_WGET } from './wget.ts'

export const GENERAL_COMMANDS: readonly RegisteredCommand[] = [
  ...GENERAL_BC,
  ...GENERAL_CURL,
  ...GENERAL_DATE,
  ...GENERAL_EXPR,
  ...GENERAL_PYTHON,
  ...GENERAL_PYTHON3,
  ...GENERAL_SEQ,
  ...GENERAL_SLEEP,
  ...GENERAL_WGET,
]

export const HISTORY_COMMANDS: readonly RegisteredCommand[] = [...GENERAL_HISTORY]
