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

from collections.abc import Mapping

from mirage.errors import FsCondition
from mirage.runtime.constants import HARD_LINK_REFUSAL

# The `os` functions this patch answers, keyed by name. ROUTED_CALLS
# names the ops each goes through: several share one op and a few need
# two (lstat reads the node table before the mount), so a value is a
# tuple. REFUSED_CALLS answers with a condition. Any other name keeps the
# host function, so the coverage test in
# tests/runtime/python/host/test_constants.py lists the ones that keep it
# on purpose, because nothing they take is a path a mount could serve,
# and fails on any other path-taking name, which would keep the host
# function with a mounted path in hand.
ROUTED_CALLS: Mapping[str, tuple[str, ...]] = {
    "access": ("stat",),
    "chmod": ("setattr",),
    "chown": ("setattr",),
    "getxattr": ("getxattr",),
    "lchmod": ("setattr",),
    "lchown": ("setattr",),
    "listdir": ("readdir",),
    "listxattr": ("listxattr",),
    "lstat": ("readlink", "stat"),
    "makedirs": ("mkdir",),
    "mkdir": ("mkdir",),
    "open": ("stat", "create", "truncate"),
    "readlink": ("readlink",),
    "remove": ("unlink",),
    "removedirs": ("rmdir",),
    "removexattr": ("removexattr",),
    "rename": ("rename",),
    "renames": ("rename",),
    "replace": ("rename",),
    "rmdir": ("rmdir",),
    "scandir": ("readdir", "stat"),
    "setxattr": ("setxattr",),
    "stat": ("stat",),
    "symlink": ("symlink",),
    "truncate": ("truncate",),
    "unlink": ("unlink",),
    "utime": ("setattr",),
    "walk": ("readdir", "stat"),
}

# REFUSED is every verb whose fact has nowhere to live. A mount stores
# content and a name plane stores links and attribute overlays; none of
# them holds a second name for one inode, a device number, or a
# filesystem-wide block count, so these cannot be faked without lying
# to the guest.
#
# `chdir` is refused because a host process cwd cannot be a virtual
# path; a runtime whose guest has its own cwd (Emscripten does) serves it
# inside that guest and never reaches this table.
# `link`, `mkfifo` and `mknod` refuse with EPERM instead, because that
# is what link(2) and mknod(2) document for a filesystem that does not
# support the requested node (vfat answers link() exactly this way), so
# the refusal arrives in the errno real programs already handle.

REFUSED_CALLS: Mapping[str, FsCondition] = {
    "chdir": FsCondition.ENOTSUP,
    "chflags": FsCondition.ENOTSUP,
    "chroot": FsCondition.ENOTSUP,
    "fwalk": FsCondition.ENOTSUP,
    "lchflags": FsCondition.ENOTSUP,
    "link": HARD_LINK_REFUSAL,
    "mkfifo": FsCondition.EPERM,
    "mknod": FsCondition.EPERM,
    "statvfs": FsCondition.ENOTSUP,
}

# The calls that take a descriptor rather than a path. The routed `open`
# hands a mounted file a number of its own (see host/descriptors.py), and
# these answer for that number and leave every other one to the host;
# `fdopen` wraps it, which `io.open` on the number does too.
DESCRIPTOR_CALLS: frozenset[str] = frozenset(
    {
        "close",
        "fchmod",
        "fchown",
        "fdatasync",
        "fdopen",
        "fstat",
        "fsync",
        "ftruncate",
        "lseek",
        "pread",
        "pwrite",
        "read",
        "write",
    }
)

# The block size every mirage stat translator reports; a backend has no
# block size of its own, and 4 KiB is what the FUSE adapters already
# answer.
BLKSIZE = 4096

# setxattr(2)'s flags as linux numbers them, the one platform whose os
# module has the xattr family for this router to install.
XATTR_CREATE = 1
XATTR_REPLACE = 2
