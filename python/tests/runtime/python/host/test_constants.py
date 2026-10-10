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

import inspect
import os

from mirage.runtime.python.host.constants import REFUSED_CALLS, ROUTED_CALLS

# Names whose path-shaped argument is not a mount-addressable path:
# string conversions, environment and sysconf keys, descriptor-to-
# descriptor transfers, and the exec and spawn families, which name a
# program for the host to run rather than a file to serve. They keep
# host behavior even when a mounted path is spelled, so a surface must
# not route or refuse them.
PASSTHROUGH_CALLS = frozenset(
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

CLASSIFIED = (
    frozenset(ROUTED_CALLS) | frozenset(REFUSED_CALLS) | PASSTHROUGH_CALLS
)

PATH_PARAMS = frozenset(
    {
        "path",
        "src",
        "dst",
        "top",
        "source",
        "target",
        "link",
        "old",
        "new",
        "filename",
        "file",
        "name",
        "paths",
        "entry",
        "dirname",
    }
)
UNINTROSPECTABLE = frozenset({"utime"})

# Names one platform has and another does not, so the existence check
# below cannot demand them. The BSD flag verbs and `lchmod` are macOS
# only; the xattr family, `memfd_create`, `splice` and
# `copy_file_range` are linux only.
PLATFORM_SPECIFIC = frozenset(
    {
        "chflags",
        "copy_file_range",
        "getxattr",
        "lchflags",
        "lchmod",
        "listxattr",
        "memfd_create",
        "removexattr",
        "setxattr",
        "splice",
    }
)

# What the sweep below reports on linux, which is what CI runs. Frozen
# here so a macOS run catches a linux-only gap; regenerate with the
# sweep under `docker run --rm python:3.12-slim`.
LINUX_PATH_TAKING = frozenset(
    {
        "access",
        "chdir",
        "chmod",
        "chown",
        "chroot",
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
        "fwalk",
        "getxattr",
        "lchown",
        "link",
        "listdir",
        "listxattr",
        "lstat",
        "makedirs",
        "memfd_create",
        "mkdir",
        "mkfifo",
        "mknod",
        "open",
        "pathconf",
        "putenv",
        "readlink",
        "remove",
        "removedirs",
        "removexattr",
        "rename",
        "renames",
        "replace",
        "rmdir",
        "scandir",
        "setxattr",
        "spawnl",
        "spawnle",
        "spawnlp",
        "spawnlpe",
        "spawnv",
        "spawnve",
        "spawnvp",
        "spawnvpe",
        "splice",
        "stat",
        "statvfs",
        "symlink",
        "sysconf",
        "truncate",
        "unlink",
        "unsetenv",
        "utime",
        "walk",
    }
)


def _path_taking_os_names() -> set[str]:
    found: set[str] = set(UNINTROSPECTABLE)
    for name in dir(os):
        if name.startswith("_"):
            continue
        fn = getattr(os, name)
        if not callable(fn):
            continue
        try:
            sig = inspect.signature(fn)
        except (ValueError, TypeError):
            continue
        if set(sig.parameters) & PATH_PARAMS:
            found.add(name)
    return found


class TestCallCoverage:
    def test_every_path_taking_os_name_is_classified(self):
        # An unclassified name keeps the host function with a mounted
        # path in hand; this failing is a name whose answer nobody
        # decided. Put it in one of the three tables.
        missing = sorted(_path_taking_os_names() - CLASSIFIED)
        assert missing == []

    def test_tables_are_disjoint(self):
        assert not (frozenset(ROUTED_CALLS) & frozenset(REFUSED_CALLS))
        assert not (frozenset(ROUTED_CALLS) & PASSTHROUGH_CALLS)
        assert not (frozenset(REFUSED_CALLS) & PASSTHROUGH_CALLS)

    def test_the_linux_sweep_is_classified_too(self):
        # CI runs linux and development runs macOS, so the two name sets
        # differ; without this the gap only shows up in CI.
        assert sorted(LINUX_PATH_TAKING - CLASSIFIED) == []

    def test_every_classified_name_exists_in_os(self):
        # A typo'd row would classify a verb no guest can ever spell,
        # leaving the real one to the host function.
        missing = [
            n for n in CLASSIFIED - PLATFORM_SPECIFIC if not hasattr(os, n)
        ]
        assert sorted(missing) == []
