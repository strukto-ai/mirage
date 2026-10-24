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

/** One command that changes files, and the ops it runs on. */
export interface Change {
  /** How the documents name it. */
  readonly label: string
  /** Its words, as a profile's rules match them; empty for a redirection, which no rule names. */
  readonly command: readonly string[]
  /** Alternatives, each the ops a mount must answer for it to work there. */
  readonly needs: readonly (readonly string[])[]
}
