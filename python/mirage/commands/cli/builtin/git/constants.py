# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from string import ascii_letters

from dulwich.refs import Ref

# The modes git records in a tree. It reads only the owner execute bit
# to choose between the two regular ones, and a mount that reports no
# mode at all stages the ordinary one. A symlink is its own object
# type, and its blob is the target string rather than anything the
# target holds; symlinks are namespace state in mirage, so that mode is
# only ever reached through the name plane.
REGULAR = 0o100644
EXECUTABLE = 0o100755
SYMLINK = 0o120000
# A gitlink: the commit another repository is checked out at. It is not
# an object this repository holds, so nothing about it is written into
# the working tree; git only makes sure a directory stands at the name.
GITLINK = 0o160000
# A subtree, which git spells 40000 in a tree object and 040000 when it
# prints one.
TREE = 0o040000
OWNER_EXECUTE = 0o100
# The part of a tree entry's mode that is a permission: what a restored
# entry's own bits are set from, the object type above it being the
# mount's business rather than the tree's.
PERMISSION_BITS = 0o777

# The object types git knows, in its own order.
OBJECT_TYPES = ("blob", "tree", "commit", "tag")

# The symbolic ref every verb resolves first, and the ref-space spelling
# dulwich takes for it.
HEAD = "HEAD"
HEAD_REF = Ref(b"HEAD")

# git's default funcname: the nearest earlier line that starts with a
# letter, "_" or "$" names a hunk, trimmed of the only four bytes git's
# own ctype calls blank.
FUNCNAME_START = frozenset(ascii_letters + "_$")
GIT_SPACE = b" \t\n\r"

# The directory (or, in a linked worktree, the file) a checkout keeps
# its repository under.
GIT_DIR = ".git"

# The pretty kinds a placeholder template spells, and the kinds that end
# every entry with a newline rather than separating entries by one.
TEMPLATE_KINDS = ("format", "tformat")
TERMINATED_KINDS = ("oneline", "tformat")

# The rules a short ref name is tried against, in the order
# gitrevisions(7) lists them.
DWIM_RULES = (
    "{}",
    "refs/{}",
    "refs/tags/{}",
    "refs/heads/{}",
    "refs/remotes/{}",
    "refs/remotes/{}/HEAD",
)

# The branch a new repository, or a clone whose remote names no usable
# HEAD, starts on when nothing says otherwise.
DEFAULT_BRANCH = "master"
