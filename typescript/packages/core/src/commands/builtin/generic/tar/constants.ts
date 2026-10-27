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

// Every diagnostic below is GNU tar 1.35's own wording, pinned on
// debian:stable-slim; only the hint line is mirage's, for the reason
// usage.oldOptionError gives (mirage's tar serves no --usage). The
// archive's own diagnostics are mirage-rs's.
export const USAGE_HINT = "Try 'tar --help' for more information."
export const EMPTY_ARCHIVE = 'tar: Cowardly refusing to create an empty archive'
// argp's mode refusals: a second main operation where the first one is already
// set, and a line that never names one. The double space is GNU's.
export const MODE_CONFLICT =
  "tar: You may not specify more than one '-Acdtrux', '--delete' or  '--test-label' option"
export const NO_MODE =
  "tar: You must specify one of the '-Acdtrux', '--delete' or '--test-label' options"
export const MULTIPLE_ARCHIVES = "tar: Multiple archive files require '-M' option"
// A --strip-components value that is no count, named first.
export const STRIP_COUNT = 'tar: {}: Invalid number of elements'
// GNU normalizes an empty operand to `.` before it stats it, says so, and
// then still names the operand as typed when the stat fails (tar 1.35).
export const EMPTY_MEMBER = "tar: Substituting `.' for empty member name"
export const FATAL_TRAILER = 'tar: Error is not recoverable: exiting now'
export const SELF_DUMP = 'archive cannot contain itself; not dumped'
// The exit GNU gives an operand it could not read, and a -C it could not
// enter. Both are fatal for the whole run, not per-operand.
export const CREATE_ERROR_EXIT = 2
