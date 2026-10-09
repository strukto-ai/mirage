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
# tuple. REFUSED_CALLS answers with a condition, and PASSTHROUGH_CALLS
# keeps the host function, because nothing it takes is a path a mount
# could serve. A path-taking name in none of the three keeps the host
# function with a mounted path in hand, which is why the coverage test
# in tests/runtime/python/host/test_constants.py fails on any such name.
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
# `open` is the fd tier rather than a missing fact: serving it means an
# fd table with host-visible numbers, which `runtime/handles` builds for
# the runtimes and this entry point has no equivalent of. `chdir` is refused
# because a host process cwd cannot be a virtual path; a runtime whose
# guest has its own cwd (Emscripten does) serves it inside that guest
# and never reaches this table.
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
    "open": FsCondition.ENOTSUP,
    "statvfs": FsCondition.ENOTSUP,
}

# Names whose path-shaped argument is not a mount-addressable path:
# string conversions, environment and sysconf keys, descriptor-to-
# descriptor transfers, and the exec and spawn families, which name a
# program for the host to run rather than a file to serve. They keep
# host behavior even when a mounted path is spelled, so a surface must
# not route or refuse them.

PASSTHROUGH_CALLS: frozenset[str] = frozenset(
    {
        "confstr",
        "copy_file_range",
        "execl",
        "execle",
        "execlp",
        "execlpe",
        "execv",
        "execve",
        "execvp",
        "execvpe",
        "fpathconf",
        "fsdecode",
        "fsencode",
        "fspath",
        "memfd_create",
        "pathconf",
        "posix_spawn",
        "posix_spawnp",
        "putenv",
        "spawnl",
        "spawnle",
        "spawnlp",
        "spawnlpe",
        "spawnv",
        "spawnve",
        "spawnvp",
        "spawnvpe",
        "splice",
        "sysconf",
        "unsetenv",
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
