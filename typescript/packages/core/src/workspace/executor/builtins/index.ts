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

export { handleCd, handlePwd, splitModeOptions } from './dirs/index.ts'
export {
  acceptsLine,
  followPaths,
  handleLn,
  handleReadlink,
  linkFlags,
  prepareMv,
  stripLinkOperands,
} from './links/index.ts'
export { handleDf } from './df/index.ts'
export {
  handleChgrp,
  handleChmod,
  handleChown,
  handleGetfattr,
  handleSetfattr,
  handleTouch,
} from './metadata/index.ts'
export {
  handleDeclareFunctions,
  handleDeclarePrint,
  handleExport,
  handleLocal,
  handleReadonly,
  noteLocalArray,
} from './declare/index.ts'
export { handleEnv } from './env/index.ts'
export { handleGetopts } from './getopts/index.ts'
export { handleLet } from './let/index.ts'
export { handlePrintenv } from './printenv/index.ts'
export { handleRead } from './read/index.ts'
export { handleSet } from './set/index.ts'
export { handleShift } from './shift/index.ts'
export { handleTrap } from './trap/index.ts'
export { handleUnset } from './unset/index.ts'
export { handleWhoami } from './whoami/index.ts'
export { handleMan } from './man/index.ts'
export { handleMapfile } from './mapfile/index.ts'
export { handleShopt } from './shopt/index.ts'
export { handleUmask } from './umask/index.ts'
export { handleAlias, handleUnalias } from './alias/index.ts'
export { divertStatement, handleExecCommand, installExecRedirects } from './exec/index.ts'
export { handleHistory } from './history/index.ts'
export { handleEval } from './eval/index.ts'
export { handleBash, handleExecPath, handleSource } from './script/index.ts'
export { handleSleep } from './sleep/index.ts'
export { handleTest } from './condition/index.ts'
export {
  handleColon,
  handleExit,
  handleFalse,
  handleReturn,
  handleTrue,
  loopLevels,
} from './control/index.ts'
export { handleTimeout } from './timeout/index.ts'
export { handleXargs } from './xargs/index.ts'
export { handleCommandBuiltin } from './command/index.ts'
export { handleType, handleWhich } from './lookup/index.ts'
export { handleEcho } from './echo/index.ts'
export { handlePrintf } from './printf/index.ts'
