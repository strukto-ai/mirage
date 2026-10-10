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

from mirage.vfs.base import BaseVFS
from mirage.vfs.call import call_names, declared_calls
from mirage.vfs.constants import WRITE_EFFECTS
from mirage.vfs.types import Declaration, Effect, Target

# The ops the namespace answers itself, declared the way ``vfs_call``
# declares a VFS function: a link and an extended attribute live on the
# path's node, never in a backend.
NAMESPACE_CALLS = {
    "symlink": Declaration(Effect.CREATE, Target.LINK, False),
    "readlink": Declaration(Effect.READ, Target.LINK, False),
    "getxattr": Declaration(Effect.READ, Target.ANY, False),
    "listxattr": Declaration(Effect.READ, Target.ANY, False),
    "setxattr": Declaration(Effect.ATTR, Target.ANY, False),
    "removexattr": Declaration(Effect.ATTR, Target.ANY, False),
}

# The built-in functions every mount answers, as ``BaseVFS`` declares
# them; every op class below is read off these and the namespace's.
_VFS_CALLS = declared_calls(BaseVFS)
_CALLS = {**_VFS_CALLS, **NAMESPACE_CALLS}

# The content reads the warm file cache may answer: a cached whole-file
# value can serve them (sliced for ranged reads) without touching the
# backend, subject to the reconciler's consistency check.
DISPATCH_READ_OPS = call_names(
    _VFS_CALLS, effects={Effect.READ}, targets={Target.FILE}
)

# Backend mutations that run the dispatcher's post-write bookkeeping:
# file-cache eviction, parent index invalidation, and overlay time
# clearing (plus the observed-mtime stamp for the content writes in
# ``STAMP_WRITE_OPS``). An attribute change keeps its own overlay
# bookkeeping in ``_apply_setattr``.
DISPATCH_WRITE_OPS = call_names(
    _VFS_CALLS, effects=WRITE_EFFECTS - {Effect.ATTR}
)

# What the admission gates classify as a write (``VfsContext.write``):
# every op that changes the mount, including the attribute changes and
# the namespace's own writes, which need write admission without joining
# the post-write invalidation path.
POLICY_WRITE_OPS = call_names(_CALLS, effects=WRITE_EFFECTS)

# The extended-attribute ops, which the node table answers: what a caller
# sets is stored on the path's node beside the overlay's mode and times.
XATTR_OPS = frozenset({"getxattr", "listxattr", "setxattr", "removexattr"})

# Ops the node table itself answers: a symlink is namespace state with
# no backend behind it, so the dispatcher is the authority for both
# directions (create and readlink) rather than a router to a mount.
NAMESPACE_TABLE_OPS = call_names(NAMESPACE_CALLS, targets={Target.LINK})

# Ops the node table answers when the path itself is a link, and only
# then. The name is the whole of what exists there, so forwarding one
# reaches a backend that has never heard of it: an unlink answered
# ENOENT with the link still in the table, and a rename moved nothing.
# ``stat`` joins them only under ``nofollow``, which is how a caller
# spells lstat; a following stat arrives already resolved to its target.
LINK_ENTRY_OPS = frozenset({"unlink", "rename", "stat"})

# Ops that change a file's bytes or its name. A store that cannot write
# in place (S3, redis) answers pwrite, append and truncate by reading
# the file and writing it back whole, so two of these on one path at
# once could each put back bytes the other had just replaced; the
# dispatcher runs them one at a time per path, as a kernel's inode lock
# orders writers to one file. A file copy holds both its names, so it
# never copies a file another writer is halfway through.
SERIAL_WRITE_OPS = call_names(
    _VFS_CALLS,
    effects={Effect.WRITE, Effect.REMOVE, Effect.RENAME, Effect.COPY},
    targets={Target.FILE, Target.ANY},
)

# Ops whose ``dst`` holds a copy of what their path holds: the path is
# read and only the ``dst`` written.
COPY_OPS = call_names(_VFS_CALLS, effects={Effect.COPY})

# Ops whose ``dst`` keyword is a name they create: walked as a create,
# judged as a write, and on the mount that serves the path.
DESTINATION_OPS = frozenset({"rename"}) | COPY_OPS

# Ops that reach everything below their paths: a read-only region or a
# path rule anywhere under one is theirs to answer for.
SUBTREE_OPS = frozenset(name for name, mark in _CALLS.items() if mark.subtree)

# Ops a backend answers in one call for what a walk does entry by entry.
# When a hide, the command's path rules or a coded policy reach below
# the path, the dispatcher declines them (ENOTSUP; a search answers
# None) and the caller walks, so every entry passes the checks a walk's
# own calls pass.
NATIVE_WALK_OPS = SUBTREE_OPS - {"rename"} | COPY_OPS

# Ops that open the regular file they name with O_CREAT, which answers
# a slash-terminated name (`x/`, only ever a directory) with EISDIR.
FILE_CREATE_OPS = call_names(_VFS_CALLS, effects={Effect.WRITE}, creates=True)

# Ops that create the name itself: an existing one answers EEXIST, before
# a trailing slash on it is judged.
ENTRY_CREATE_OPS = call_names(_CALLS, effects={Effect.CREATE})

# Ops that create the path they name. A hidden target refuses these
# through `hidden_refusal` with `create` set: EACCES when the directory
# the create lands in is visible (a hidden name there reads as a file
# the session cannot write), ENOENT when that directory is hidden too,
# the same answer every read gives for it. Every other op on a hidden
# path answers ENOENT, the no-name-leak rule.
HIDDEN_CREATE_OPS = FILE_CREATE_OPS | ENTRY_CREATE_OPS

# The attribute fields a setattr op can carry, in one place so the
# requested/residual split and the overlay write read the same names.
SETATTR_KEYS = ("mode", "uid", "gid", "atime", "mtime")

# Ops with lstat semantics: they act on the entry named by the path, so
# no stat surface (dispatch, the Files facade, FUSE) may rewrite their
# operand through the symlink table.
NO_FOLLOW_OPS = call_names(
    _CALLS, effects={Effect.REMOVE, Effect.RENAME}
) | call_names(_CALLS, targets={Target.LINK})

# Content-writing ops whose completion stamps an observed mtime on the
# namespace node (removals invalidate but must not stamp).
STAMP_WRITE_OPS = call_names(_VFS_CALLS, effects={Effect.WRITE, Effect.CREATE})
