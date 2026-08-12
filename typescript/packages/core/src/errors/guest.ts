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

import type { FsCondition, GuestSeat } from './types.ts'

// The monty encoders' view: which builtin exception a guest should be
// able to `except`, with CPython-on-Linux numbering. A guest
// interpreter is platform-neutral, so these must not wobble with the
// host the way a kernel adapter's table does.
export const GUEST: Record<FsCondition, GuestSeat> = {
  ENOENT: { name: 'FileNotFoundError', errno: 2, phrase: 'No such file or directory' },
  ENOTDIR: { name: 'NotADirectoryError', errno: 20, phrase: 'Not a directory' },
  EISDIR: { name: 'IsADirectoryError', errno: 21, phrase: 'Is a directory' },
  EEXIST: { name: 'FileExistsError', errno: 17, phrase: 'File exists' },
  EACCES: { name: 'PermissionError', errno: 13, phrase: 'Permission denied' },
  EPERM: { name: 'PermissionError', errno: 1, phrase: 'Operation not permitted' },
  ENOTEMPTY: { name: 'OSError', errno: 39, phrase: 'Directory not empty' },
  EXDEV: { name: 'OSError', errno: 18, phrase: 'Invalid cross-device link' },
  // pathlib's answer for a cross-mount rename: monty ships no shutil,
  // so guest code writes the copy-and-delete fallback by hand and the
  // errno is what tells it to.
  CROSS_MOUNT: { name: 'OSError', errno: 18, phrase: 'Invalid cross-device link' },
  ENOTSUP: { name: 'OSError', errno: 95, phrase: 'Operation not supported' },
  ELOOP: { name: 'OSError', errno: 40, phrase: 'Too many levels of symbolic links' },
  EINVAL: { name: 'OSError', errno: 22, phrase: 'Invalid argument' },
  EIO: { name: 'OSError', errno: 5, phrase: 'Input/output error' },
  EBUSY: { name: 'OSError', errno: 16, phrase: 'Device or resource busy' },
  EROFS: { name: 'OSError', errno: 30, phrase: 'Read-only file system' },
  NO_XATTR: { name: 'OSError', errno: 61, phrase: 'No data available' },
}

/** The guest-python rendering for a condition. */
export function guestSeat(condition: FsCondition): GuestSeat {
  return GUEST[condition]
}
