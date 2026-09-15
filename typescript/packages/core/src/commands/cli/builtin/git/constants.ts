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

// The modes git records in a tree. It reads only the owner execute bit to
// choose between the two regular ones, and a mount that reports no mode at all
// stages the ordinary one. A symlink is its own object type, and its blob is
// the target string rather than anything the target holds; symlinks are
// namespace state in mirage, so that mode is only ever reached through the
// name plane.
export const REGULAR = 0o100644
export const EXECUTABLE = 0o100755
export const SYMLINK = 0o120000
export const OWNER_EXECUTE = 0o100
// The part of a tree entry's mode that is a permission: what a restored
// entry's own bits are set from, the object type above it being the mount's
// business rather than the tree's.
export const PERMISSION_BITS = 0o777
// The same mode as `SYMLINK`, in the spelling a tree entry carries. The index
// records a number and a tree records git's octal string, so both spellings
// are real here and neither is a stand-in for the other.
export const SYMLINK_MODE = '120000'
/**
 * A gitlink: the commit another repository is checked out at. It is not an
 * object this repository holds, so nothing about it is written into the working
 * tree; git only makes sure a directory stands at the name.
 */
export const GITLINK_MODE = '160000'

// The symbolic ref every verb resolves first.
export const HEAD = 'HEAD'

// The directory (or, in a linked worktree, the file) a checkout keeps its
// repository under.
export const GIT_DIR = '.git'
