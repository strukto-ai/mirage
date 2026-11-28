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
 * A file's fingerprint: its inode and the time its last write landed at, to
 * the nanosecond.
 *
 * Every write lands past the time the database gave the write before
 * (`nowStamp`), so a rewrite always moves it, a same-size one in the same
 * instant included; the inode tells a file renamed over the name from the
 * one it replaced. The limit: a time set by hand (`touch -r`) lands in the
 * same columns, and the table keeps no change time a caller cannot set, so a
 * same-size rewrite whose time is then set back to the one the file had is not
 * seen. Mirrors Python's `token_of`.
 *
 * @param ino the file's inode
 * @param seconds its `mtime`
 * @param nanoseconds its `mtime_nsec`
 */
export function tokenOf(ino: number, seconds: number, nanoseconds: number): string {
  return `${String(ino)}:${String(seconds)}.${String(nanoseconds).padStart(9, '0')}`
}
