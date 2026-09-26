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

import type { CompressionKind } from './types.ts'

export const COMPRESSION_SIGNATURES: Readonly<Record<CompressionKind, readonly number[]>> =
  Object.freeze({
    gzip: [0x1f, 0x8b],
    bzip2: [0x42, 0x5a, 0x68],
    xz: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00],
  })

// Every diagnostic below is GNU tar 1.35's own wording, pinned on
// debian:stable-slim; only the hint line is mirage's, for the reason
// usage.oldOptionError gives (mirage's tar serves no --usage).
export const USAGE_HINT = "Try 'tar --help' for more information."
export const EMPTY_ARCHIVE = 'tar: Cowardly refusing to create an empty archive'
export const FATAL_TRAILER = 'tar: Error is not recoverable: exiting now'
// What tar adds when its gzip -d child fails, after gzip's own lines.
export const CHILD_STATUS = 'tar: Child returned status {}'
export const INVALID_ARCHIVE = [
  'tar: This does not look like a tar archive',
  'tar: Skipping to next header',
] as const
export const ERROR_TRAILER = 'tar: Exiting with failure status due to previous errors'
export const SELF_DUMP = 'archive cannot contain itself; not dumped'
// The exit GNU gives an operand it could not read, and a -C it could not
// enter. Both are fatal for the whole run, not per-operand.
export const CREATE_ERROR_EXIT = 2
