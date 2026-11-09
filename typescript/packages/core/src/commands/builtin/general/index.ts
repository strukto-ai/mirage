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
import { GENERAL_BC } from './bc/index.ts'
import { GENERAL_CURL } from './curl.ts'
import { GENERAL_DATE } from './date.ts'
import { GENERAL_EXPR } from './expr.ts'
import { GENERAL_GETCONF } from './getconf.ts'
import { GENERAL_HOSTNAME } from './hostname.ts'
import { GENERAL_ID } from './id.ts'
import { GENERAL_JS, node } from './js.ts'
import { pythonCmd, python3 } from './python.ts'
import { GENERAL_SEQ } from './seq.ts'
import { GENERAL_UNAME } from './uname.ts'
import { GENERAL_WGET } from './wget.ts'
import { GENERAL_ARCH } from './arch.ts'
import { GENERAL_COLRM } from './colrm.ts'
import { GENERAL_ENVSUBST } from './envsubst.ts'
import { GENERAL_GROUPS } from './groups.ts'
import { GENERAL_HOSTID } from './hostid.ts'
import { GENERAL_LINK } from './link.ts'
import { GENERAL_LOGNAME } from './logname.ts'
import { GENERAL_NPROC } from './nproc.ts'
import { GENERAL_PATHCHK } from './pathchk.ts'
import { GENERAL_SYNC } from './sync.ts'
import { GENERAL_TTY } from './tty.ts'
import { GENERAL_USERS } from './users.ts'
import { GENERAL_WHO } from './who.ts'
import { GENERAL_YES } from './yes.ts'

export const GENERAL_COMMANDS: readonly Command[] = [
  ...GENERAL_BC,
  ...GENERAL_CURL,
  ...GENERAL_DATE,
  ...GENERAL_EXPR,
  ...GENERAL_GETCONF,
  ...GENERAL_HOSTNAME,
  ...GENERAL_ID,
  ...GENERAL_JS,
  ...node,
  ...pythonCmd,
  ...python3,
  ...GENERAL_SEQ,
  ...GENERAL_UNAME,
  ...GENERAL_WGET,
  ...GENERAL_ARCH,
  ...GENERAL_COLRM,
  ...GENERAL_ENVSUBST,
  ...GENERAL_GROUPS,
  ...GENERAL_HOSTID,
  ...GENERAL_LINK,
  ...GENERAL_LOGNAME,
  ...GENERAL_NPROC,
  ...GENERAL_PATHCHK,
  ...GENERAL_SYNC,
  ...GENERAL_TTY,
  ...GENERAL_USERS,
  ...GENERAL_WHO,
  ...GENERAL_YES,
]
