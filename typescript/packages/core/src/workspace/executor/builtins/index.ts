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

export type { ExecuteStringFn } from './scope.ts'

export { handleCd } from './dirs.ts'
export {
  followPaths,
  handleLn,
  handleReadlink,
  linkFlags,
  prepareMv,
  stripLinkOperands,
} from './links.ts'
export { handleDf } from './capacity.ts'
export { handleChgrp, handleChmod, handleChown, handleTouch } from './metadata.ts'
export {
  handleEnv,
  handleExit,
  handleExport,
  handleGetopts,
  handleLocal,
  handlePrintenv,
  handleRead,
  handleReadonly,
  handleReturn,
  handleSet,
  handleShift,
  handleTrap,
  handleUnset,
  handleWhoami,
} from './vars.ts'
export { handleMan } from './man.ts'
export { handleHistory } from './history.ts'
export { handleBash, handleEval, handleSleep, handleSource } from './script.ts'
export { handleTest } from './condition/index.ts'
export { handleTimeout } from './timeout.ts'
export { handleXargs } from './xargs.ts'
export { handleCommandBuiltin, handleType } from './command.ts'
export { handleEcho, handlePrintf } from './text.ts'
