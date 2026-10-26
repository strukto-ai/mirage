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

export const KILLED_EXIT_CODE = 137

// How long `wait` gives a killed job's runner to stop what it started (a
// sandbox reaps for up to 5 s after a 1 s grace) before it answers with the
// status the kill recorded.
export const STOP_WAIT_SECONDS = 10

// How long an owner's lease lasts on a store other processes share. The
// owner renews it at a third of that while it runs jobs, so a workspace that
// dies is seen as gone at most this long after its last renewal.
export const LEASE_SECONDS = 30

// The status a job lost with its owner answers: SIGHUP's, as bash's job
// answers when its terminal goes.
export const HANGUP_EXIT_CODE = 129

// How long a shared console's output is kept after its last write, so the
// streams of jobs nobody reaps do not accumulate.
export const CONSOLE_TTL_SECONDS = 86400

// How many times a job-list write retries against other writers before it
// gives up: every workspace of a session writes the one record.
export const LIST_MAX_RETRIES = 32
