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

/**
 * One server the CLI talks to, with what it remembers there: its URL
 * (empty for `local`, whose URL follows the daemon's port), the team the
 * login acts for if the server names one, and the workspace commands use
 * when given none.
 */
export interface Context {
  url: string
  team: string | null
  workspace: string | null
}

/** The contexts file: which context is current, and every context; `local` is always there. */
export interface Contexts {
  current: string
  contexts: Record<string, Context>
}
