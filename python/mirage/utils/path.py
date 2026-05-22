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

import posixpath


def resolve_path(path: str, cwd: str) -> str:
    """Resolve a relative path against cwd.

    Example::

        resolve_path("../file.txt", "/data/sub/")
            → "/data/file.txt"
        resolve_path("/abs/path", "/ignored")
            → "/abs/path"
    """
    if not path.startswith("/"):
        path = cwd.rstrip("/") + "/" + path
    return posixpath.normpath(path)


def gnu_basename(path: str, suffix: str | None = None) -> str:
    i = len(path)
    while i > 0 and path[i - 1] == "/":
        i -= 1
    if i == 0:
        return "/" if path else ""
    j = path.rfind("/", 0, i)
    base = path[j + 1:i]
    if suffix and base != suffix and base.endswith(suffix):
        base = base[:len(base) - len(suffix)]
    return base


def gnu_dirname(path: str) -> str:
    if path == "":
        return "."
    i = len(path)
    while i > 0 and path[i - 1] == "/":
        i -= 1
    if i == 0:
        return "/"
    j = path.rfind("/", 0, i)
    if j == -1:
        return "."
    while j > 0 and path[j - 1] == "/":
        j -= 1
    if j == 0:
        return "/"
    return path[:j]
