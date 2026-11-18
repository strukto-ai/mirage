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

from mirage.errors.types import FsCondition

# The commands a mount whose files sit behind a POSIX shell (an SSH host,
# a machine) runs where the files are, each in the C locale so names and
# bytes compare as Mirage reads them, under any login shell.

# Every entry under a scope, links followed, one NUL-ended record each:
# find's type letter, mode, size, times, owner and group names (numbers
# when they have none) and relative path.
FIND = "env LC_ALL=C find -L"
TREE_FORMAT = "%y %m %s %T@ %A@ %U %G %P\\0"

WC = "env LC_ALL=C wc -l"

# grep reads every file the walk reaches, a link's target included
# (--dereference-recursive, GNU's spelling of -R: BSD grep's -R follows no
# link, and refuses this one); --devices=skip, so a FIFO the walk would
# never read cannot block it; --null, so a name ends where a NUL does.
GREP = "env LC_ALL=C grep --dereference-recursive --devices=skip -lF --null"

CP = "env LC_ALL=C cp -RL --"
COPIED = b"copied\n"

# The coreutils sum per hashlib name, and its digest's width in hex.
SUMS = {
    "md5": ("md5sum", 32),
    "sha1": ("sha1sum", 40),
    "sha224": ("sha224sum", 56),
    "sha256": ("sha256sum", 64),
    "sha384": ("sha384sum", 96),
    "sha512": ("sha512sum", 128),
}

# What a POSIX shell other than bash says where bash names the error by its
# strerror: dash, the /bin/sh of Debian and Ubuntu, says a redirect's folder
# is missing as "cannot create f: Directory nonexistent".
SHELL_PHRASES = {"Directory nonexistent": FsCondition.ENOENT}
