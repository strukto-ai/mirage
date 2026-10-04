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

const S_IFDIR = 0o040000
const S_IFREG = 0o100000

export const DIR_MODE = S_IFDIR | 0o777
export const FILE_MODE = S_IFREG | 0o666
// A link is not this filesystem's choice the way the two above are: no
// POSIX system consults the bits on a symlink, so every translator
// reports the same mode and this one is shared rather than restated.
export { LINK_MODE } from '../../../../utils/stat_view.ts'

export const BLKSIZE = 4096

// llseek's whence, which Emscripten passes through as the raw number.
export const SEEK_CUR = 1
export const SEEK_END = 2

// The smallest buffer a written file grows to; past it, each growth
// doubles the capacity.
export const GROW_FLOOR = 4096
