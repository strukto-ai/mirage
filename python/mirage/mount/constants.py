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

import os

from mirage.types import VFSName

# Who owns what a mount shows when a row names its owner by name (the
# kernel wants numbers): the mounting user. Windows has none; WinFsp
# presents files as the mounting user's.
OWNER = (os.getuid(), os.getgid()) if hasattr(os, "getuid") else (0, 0)

# The most entry stats one SFTP listing keeps in flight. Each is a hop to
# the workspace loop and, on a mount that keeps no listing index, a backend
# request, so a wide directory does not put every one on the wire.
LISTING_CONCURRENCY = 16

# How long a guest's fstat answers by the row its handle last fetched, as
# FUSE's attr_timeout does for a kernel: CPython's open() and read() stat
# the descriptor twice more right after the open.
FSTAT_ROW_SECONDS = 1.0

# How long a machine's kernel keeps what a mount served into it answered
# of a name, its absence or its attributes (sshfs's entry, negative and
# attr timeouts), so the folder checks an import repeats stay on the
# machine. What another changed in that time is waited out before a
# program starts there (``RecentChanges``).
KERNEL_CACHE_SECONDS = 1

# The extension a machine's sshfs renames with when the server names it,
# replacing what the new name held as rename(2) does: SFTP v3's own rename
# refuses an existing target, so without it `mv` over a file, git and every
# save through a temporary file fail there. asyncssh names it in its
# VERSION; TypeScript's server names it on a machine's pipe.
POSIX_RENAME = "posix-rename@openssh.com"

# The files an NFS server keeps open between reads. NFS has no open or
# close, so a read opens its file and later reads reuse that handle; past
# this many, the least recently read one no read is using is released.
OPEN_HANDLES = 64

# A client port below this one is bound by root. Linux's own NFS server
# takes only those by default (its `secure` export option), so on Linux,
# where mounting needs root, an unprivileged local user cannot reach the
# served tree by speaking NFS to it directly.
RESERVED_PORTS = 1024

# SFTP carries paths as bytes. surrogateescape is the one error policy
# under which every byte survives the str round trip.
ENCODING = "utf-8"
ERRORS = "surrogateescape"

# The SFTP version sshfs and OpenSSH speak.
SFTP_VERSION = 3

# The fsproto version a host and a machine's mirage-fuse must share
# (``mirage.mount.fsproto``).
FSPROTO_VERSION = 1

# The largest fsproto frame either side accepts.
FSPROTO_FRAME_BYTES = 64 * 1024 * 1024

# The backends whose answers mirage-fuse may keep until told otherwise:
# nothing but the workspace changes them, so every change reaches the
# machine as an invalidation (``RecentChanges``). Any other backend's
# answers last KERNEL_CACHE_SECONDS, as sshfs keeps them.
FSPROTO_KEPT: frozenset[str] = frozenset({VFSName.RAM, VFSName.SQL})

# The largest file read whole for mirage-fuse's cache, and the files and
# total a folder's prefetch carries.
FSPROTO_WHOLE_BYTES = 8 * 1024 * 1024
FSPROTO_FETCH_FILE_BYTES = 256 * 1024
FSPROTO_FETCH_DIR_BYTES = 4 * 1024 * 1024

# The entries a folder's first listing carries for the folders under it,
# so mirage-fuse walks a kept tree in a few round trips.
FSPROTO_TREE_ENTRIES = 20000
