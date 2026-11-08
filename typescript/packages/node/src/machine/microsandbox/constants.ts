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

export const MICROSANDBOX_HINT =
  'the microsandbox runtime needs `msb` on PATH (https://microsandbox.dev); ' +
  'start the sandbox before connecting'

export const RUNNING_STATE = 'Running'
export const INSPECT_TIMEOUT_SECONDS = 10

// msb reports 255 for a program a signal ended, so a run's program is a
// child of this prelude rather than exec'd by it: the prelude carries no
// `PROCESS` tag, so a signal by tag reaches the program, and it exits with
// the program's status, 128 plus the signal for one a signal ended, which
// msb reports as given. `$1` is the working directory (126 when the box
// lacks it), `$2` the tag's assignment, then the command. Mirrors Python's
// `TAGGED_PRELUDE`.
export const TAGGED_PRELUDE =
  'CDPATH= cd -- "$1" || exit 126; t=$2; shift 2; env "$t" "$@"; exit $?'
