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

import { ShellBuiltin as SB } from '../../../shell/types.ts'
import { aliasBuiltin, unaliasBuiltin } from './alias/alias.ts'
import { commandBuiltin } from './command/command.ts'
import { testBuiltin } from './condition/condition.ts'
import {
  breakBuiltin,
  colonBuiltin,
  continueBuiltin,
  exitBuiltin,
  falseBuiltin,
  returnBuiltin,
  trueBuiltin,
} from './control/control.ts'
import { exportBuiltin } from './declare/export.ts'
import { localBuiltin } from './declare/local.ts'
import { cdBuiltin } from './dirs/cd.ts'
import { pwdBuiltin } from './dirs/pwd.ts'
import { echoBuiltin } from './echo/echo.ts'
import { envBuiltin } from './env/env.ts'
import { evalBuiltin } from './eval/eval.ts'
import { execBuiltin } from './exec/exec.ts'
import { getoptsBuiltin } from './getopts/getopts.ts'
import { historyBuiltin } from './history/history.ts'
import { letBuiltin } from './let/let.ts'
import { typeBuiltin, whichBuiltin } from './lookup/lookup.ts'
import { helpBuiltin } from './help/help.ts'
import { manBuiltin } from './man/man.ts'
import { mapfileBuiltin } from './mapfile/mapfile.ts'
import { printenvBuiltin } from './printenv/printenv.ts'
import { printfBuiltin } from './printf/printf.ts'
import { readBuiltin } from './read/read.ts'
import { bashBuiltin } from './script/bash.ts'
import { sourceBuiltin } from './script/source.ts'
import { setBuiltin } from './set/set.ts'
import { shiftBuiltin } from './shift/shift.ts'
import { shoptBuiltin } from './shopt/shopt.ts'
import { sleepBuiltin } from './sleep/sleep.ts'
import { timeoutBuiltin } from './timeout/timeout.ts'
import { trapBuiltin } from './trap/trap.ts'
import type { BuiltinFn } from './types.ts'
import { umaskBuiltin } from './umask/umask.ts'
import { unsetBuiltin } from './unset/unset.ts'
import { whoamiBuiltin } from './whoami/whoami.ts'
import { xargsBuiltin } from './xargs/xargs.ts'

// The one map from an executor-run builtin word to its handler; the
// dispatcher does a single lookup here instead of one arm per word. Two
// ShellBuiltin groups are deliberately absent: the job builtins (wait, fg,
// kill, jobs, disown, ps) route through JOB_HANDLERS in
// executor/command/command.ts because they need the job table, and
// python/python3/node/js are general mount commands
// (commands/builtin/general), reserved in ShellBuiltin only so no CLI can
// take the name. table.test.ts pins that everything else is here.
export const BUILTINS: ReadonlyMap<string, BuiltinFn> = new Map<string, BuiltinFn>([
  [SB.PWD, pwdBuiltin],
  [SB.CD, cdBuiltin],
  [SB.EXPORT, exportBuiltin],
  [SB.UNSET, unsetBuiltin],
  [SB.LOCAL, localBuiltin],
  [SB.SET, setBuiltin],
  [SB.READ, readBuiltin],
  [SB.MAPFILE, mapfileBuiltin],
  [SB.READARRAY, mapfileBuiltin],
  [SB.SHIFT, shiftBuiltin],
  [SB.GETOPTS, getoptsBuiltin],
  [SB.LET, letBuiltin],
  [SB.TRAP, trapBuiltin],
  [SB.SHOPT, shoptBuiltin],
  [SB.UMASK, umaskBuiltin],
  [SB.ALIAS, aliasBuiltin],
  [SB.UNALIAS, unaliasBuiltin],
  [SB.EXEC, execBuiltin],
  [SB.TEST, testBuiltin],
  [SB.BRACKET, testBuiltin],
  [SB.DOUBLE_BRACKET, testBuiltin],
  [SB.ECHO, echoBuiltin],
  [SB.PRINTF, printfBuiltin],
  [SB.SOURCE, sourceBuiltin],
  [SB.DOT, sourceBuiltin],
  [SB.EVAL, evalBuiltin],
  [SB.COMMAND, commandBuiltin],
  [SB.TYPE, typeBuiltin],
  [SB.WHICH, whichBuiltin],
  [SB.HELP, helpBuiltin],
  [SB.TRUE, trueBuiltin],
  [SB.FALSE, falseBuiltin],
  [SB.COLON, colonBuiltin],
  [SB.BREAK, breakBuiltin],
  [SB.CONTINUE, continueBuiltin],
  [SB.RETURN, returnBuiltin],
  [SB.EXIT, exitBuiltin],
  [SB.PRINTENV, printenvBuiltin],
  [SB.ENV, envBuiltin],
  [SB.WHOAMI, whoamiBuiltin],
  [SB.MAN, manBuiltin],
  [SB.HISTORY, historyBuiltin],
  [SB.SLEEP, sleepBuiltin],
  [SB.BASH, bashBuiltin],
  [SB.SH, bashBuiltin],
  [SB.XARGS, xargsBuiltin],
  [SB.TIMEOUT, timeoutBuiltin],
])
