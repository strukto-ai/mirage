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

// filetypes
export const FT_UNKNOWN = 0
export const FT_CHR = 2
export const FT_DIR = 3
export const FT_REG = 4
export const FT_SYMLINK = 7

// lookupflags: whether a path's trailing symlink is resolved. Unset is
// how a guest spells lstat, so a verb that reads it cannot dereference.
export const LOOKUP_SYMLINK_FOLLOW = 1

// fstflags for path_filestat_set_times: which stamp the call writes and
// whether the value comes from the argument or from the host clock.
export const FST_ATIM = 1
export const FST_ATIM_NOW = 2
export const FST_MTIM = 4
export const FST_MTIM_NOW = 8

// path_open oflags
export const OFLAG_CREAT = 1
export const OFLAG_DIRECTORY = 2
export const OFLAG_EXCL = 4
export const OFLAG_TRUNC = 8

// fdflags
export const FDFLAG_APPEND = 1

// rights
export const RIGHT_FD_READ = 1n << 1n
export const RIGHT_FD_WRITE = 1n << 6n
export const ALL_RIGHTS = 2n ** 64n - 1n
