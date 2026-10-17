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

import * as constants from './constants.ts'

export class BcParseError extends Error {
  constructor(
    readonly text: string,
    readonly incomplete = false,
    readonly pos = -1,
  ) {
    super(text)
  }
}

export class BcRuntimeError extends Error {}

export class BcHalt extends Error {}
export function runtimeLine(kind: string, reason: string): string {
  return `Runtime ${kind} (func=(main), adr=${String(constants.RUNTIME_ERROR_ADDR)}): ${reason}`
}

export function runtimeErrorLine(reason: string): string {
  return runtimeLine('error', reason)
}

export function runtimeWarningLine(reason: string): string {
  return runtimeLine('warning', reason)
}

export function parseErrorLine(line: number, text: string): string {
  return `${constants.INPUT_NAME} ${String(line)}: ${text}`
}
