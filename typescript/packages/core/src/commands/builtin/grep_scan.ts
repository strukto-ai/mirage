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

// The exit status grep and ripgrep share. An operand the search could not read
// is exit 2, and it outranks a match: both tools print the lines they did find
// and still exit 2. The one exception is grep's -q, documented as exiting zero
// when a match is found "even if an error was detected". Everything else is the
// familiar 0 for a match, 1 for none.
export function exitCodeFor(matched: boolean, failed: boolean, quiet: boolean): number {
  if (matched && quiet) return 0
  if (failed) return 2
  return matched ? 0 : 1
}
