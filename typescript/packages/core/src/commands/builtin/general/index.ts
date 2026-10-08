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

import type { Command } from '../../config.ts'
import { GENERAL_BC } from './bc.ts'
import { GENERAL_CURL } from './curl.ts'
import { GENERAL_DATE } from './date.ts'
import { GENERAL_EXPR } from './expr.ts'
import { GENERAL_GETCONF } from './getconf.ts'
import { GENERAL_HOSTNAME } from './hostname.ts'
import { GENERAL_ID } from './id.ts'
import { GENERAL_JS, GENERAL_NODE } from './js.ts'
import { GENERAL_PYTHON, GENERAL_PYTHON3 } from './python.ts'
import { GENERAL_SEQ } from './seq.ts'
import { GENERAL_UNAME } from './uname.ts'
import { GENERAL_WGET } from './wget.ts'

export const GENERAL_COMMANDS: readonly Command[] = [
  ...GENERAL_BC,
  ...GENERAL_CURL,
  ...GENERAL_DATE,
  ...GENERAL_EXPR,
  ...GENERAL_GETCONF,
  ...GENERAL_HOSTNAME,
  ...GENERAL_ID,
  ...GENERAL_JS,
  ...GENERAL_NODE,
  ...GENERAL_PYTHON,
  ...GENERAL_PYTHON3,
  ...GENERAL_SEQ,
  ...GENERAL_UNAME,
  ...GENERAL_WGET,
]
