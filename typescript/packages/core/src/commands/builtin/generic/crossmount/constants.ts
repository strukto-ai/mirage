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

import { Cmd } from './types.ts'

export const STREAM_COMMANDS: ReadonlySet<string> = new Set([
  Cmd.CAT,
  Cmd.NL,
  Cmd.SORT,
  Cmd.CUT,
  Cmd.SED,
  Cmd.REV,
  Cmd.AWK,
])
const FANOUT_COMMANDS: ReadonlySet<string> = new Set([
  Cmd.GREP,
  Cmd.RG,
  Cmd.HEAD,
  Cmd.TAIL,
  Cmd.WC,
  Cmd.DU,
  Cmd.FILE,
  Cmd.MD5,
  Cmd.SHA256SUM,
  Cmd.STAT,
  Cmd.STRINGS,
  Cmd.TAC,
  Cmd.LS,
  Cmd.FIND,
  Cmd.RM,
  Cmd.TOUCH,
  Cmd.MKDIR,
  Cmd.TEE,
])
export const RELAY_COMMANDS: ReadonlySet<string> = new Set([
  Cmd.CP,
  Cmd.MV,
  Cmd.DIFF,
  Cmd.CMP,
  Cmd.PASTE,
  Cmd.COMM,
  Cmd.JOIN,
])
export const CROSS_MOUNT_COMMANDS: ReadonlySet<string> = new Set([
  ...STREAM_COMMANDS,
  ...FANOUT_COMMANDS,
  ...RELAY_COMMANDS,
])
