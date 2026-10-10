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

// The modes every translator reports for a directory, a file and a link,
// shared rather than restated so a guest's stat reads what a shell's does.
export { DIR_MODE, FILE_MODE, LINK_MODE } from '../../../../utils/stat_view.ts'

// What a create's mode loses, as a process's default umask takes it off:
// Emscripten asks 0o666 for a file and 0o777 for a directory.
export const UMASK = 0o022

export const BLKSIZE = 4096

// What st_blocks counts in, whatever the block size.
export const BLOCK_UNIT = 512

// The open flags' access bits, as Emscripten numbers them.
export const O_ACCMODE = 3

// The open flag that puts every write at the end, as Emscripten numbers it.
export const O_APPEND = 1024

// llseek's whence, which Emscripten passes through as the raw number.
export const SEEK_CUR = 1
export const SEEK_END = 2

// The smallest buffer a written file grows to; past it, each growth
// doubles the capacity.
export const GROW_FLOOR = 4096
