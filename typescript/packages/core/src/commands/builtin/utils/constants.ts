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

import { FileType } from '../../../types.ts'

export const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

export const EPOCH_LS_TIME = 'Jan  1 00:00'

export const TYPE_CHARS: Partial<Record<FileType, string>> = {
  [FileType.DIRECTORY]: 'd',
  [FileType.SYMLINK]: 'l',
}

// A symlink has no permission bits of its own on Linux: the mode is
// always 0777 and access is decided by the target, so GNU always
// renders lrwxrwxrwx.
export const DEFAULT_MODES: Partial<Record<FileType, number>> = {
  [FileType.DIRECTORY]: 0o755,
  [FileType.SYMLINK]: 0o777,
}

export const NUMERIC_PREFIX = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/
