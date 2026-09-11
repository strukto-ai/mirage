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

import { FileChangeKind } from '../../../types.ts'

export const FILE_SEGMENT = 'file:'
export const DIR_SEGMENT = 'dir'

export const DIR_SET_VERBS = new Set(['sadd', 'srem', 'del', 'unlink', 'expired'])

export const REDIS_KINDS: Record<string, FileChangeKind> = {
  set: FileChangeKind.UPDATE,
  setrange: FileChangeKind.UPDATE,
  append: FileChangeKind.UPDATE,
  incrby: FileChangeKind.UPDATE,
  copy_to: FileChangeKind.UPDATE,
  restore: FileChangeKind.UPDATE,
  rename_to: FileChangeKind.UPDATE,
  del: FileChangeKind.DELETE,
  unlink: FileChangeKind.DELETE,
  expired: FileChangeKind.DELETE,
  evicted: FileChangeKind.DELETE,
  rename_from: FileChangeKind.DELETE,
}
