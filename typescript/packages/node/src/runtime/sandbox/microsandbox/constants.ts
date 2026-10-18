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

export const MICROSANDBOX_CLI_HINT =
  'the microsandbox runtime needs the msb CLI on PATH (https://microsandbox.dev); ' +
  'start the sandbox before connecting'

export const RUNNING_STATE = 'Running'
export const INSPECT_TIMEOUT_SECONDS = 10
export const PRELUDE = 'CDPATH= cd -- "$1" && shift && exec "$@"'

/** Explain why the configured sandbox cannot take a command. */
export function notRunningHint(sandbox: string, state: string): string {
  return `sandbox ${sandbox} is not running (status: ${state}); start it with msb start`
}
