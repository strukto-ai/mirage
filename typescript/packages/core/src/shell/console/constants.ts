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

// The two forms of the CONTROL payload, "<form>:<code>": a job that ran
// to completion ends "exit:<code>" and one stopped by a signal
// "killed:<code>", the code being the status `wait` answers for it
// (utils.exitOutcome, utils.killedOutcome).
export const EXIT_OUTCOME = 'exit'
export const KILLED_OUTCOME = 'killed'

// A cursor past any console's end: reading from it returns no chunks and
// the console's length as the next cursor. Exact on both hosts.
export const END_OF_CONSOLE = Number.MAX_SAFE_INTEGER
