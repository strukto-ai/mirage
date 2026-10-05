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

export const STREAM_COMMANDS: ReadonlySet<string> = new Set([Cmd.CAT, Cmd.NL, Cmd.CUT])
// The stream commands that read their input as lines: GNU ends a file's
// unterminated last line where the next file begins (`cut -c 1` on `ab` then
// `cd` prints two lines), so the merged stream carries that newline. `cat` joins
// the bytes as they are. Mirrors Python's LINE_STREAM_COMMANDS.
export const LINE_STREAM_COMMANDS: ReadonlySet<string> = new Set([Cmd.NL, Cmd.CUT])
export const FANOUT_COMMANDS: ReadonlySet<string> = new Set([
  Cmd.REV,
  Cmd.HEAD,
  Cmd.TAIL,
  Cmd.DU,
  Cmd.FILE,
  Cmd.MD5,
  Cmd.MD5SUM,
  Cmd.SHA1SUM,
  Cmd.SHA256SUM,
  Cmd.SHA384SUM,
  Cmd.SHA512SUM,
  Cmd.STAT,
  Cmd.STRINGS,
  Cmd.TAC,
  Cmd.FIND,
  Cmd.RM,
  Cmd.RMDIR,
  Cmd.UNLINK,
  Cmd.TOUCH,
  Cmd.MKDIR,
])
export const RELAY_COMMANDS: ReadonlySet<string> = new Set([
  Cmd.CP,
  Cmd.MV,
  Cmd.TEE,
  Cmd.DIFF,
  Cmd.CMP,
  Cmd.PASTE,
  Cmd.COMM,
  Cmd.JOIN,
  Cmd.TAR,
  Cmd.UNZIP,
  Cmd.ZIP,
  Cmd.LS,
  Cmd.SORT,
  Cmd.WC,
  Cmd.AWK,
  Cmd.SED,
  Cmd.REALPATH,
  Cmd.GREP,
  Cmd.RG,
])
export const CROSS_MOUNT_COMMANDS: ReadonlySet<string> = new Set([
  ...STREAM_COMMANDS,
  ...FANOUT_COMMANDS,
  ...RELAY_COMMANDS,
])
