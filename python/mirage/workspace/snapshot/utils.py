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

FORMAT_VERSION = 3

BLOB_REF_KEY = "__file"


def is_safe_blob_path(path: str) -> bool:
    """Reject path-traversal and absolute references inside the tar.

    Allows spaces, unicode, and any printable character — restrictions
    target structural attacks only:

    - rejects empty strings
    - rejects absolute paths (leading "/")
    - rejects ".." segments
    - rejects NUL byte (forbidden in tar)
    """
    if not isinstance(path, str) or not path:
        return False
    if path.startswith("/"):
        return False
    if "\x00" in path:
        return False
    return ".." not in path.split("/")


def norm_mount_prefix(prefix: str) -> str:
    """Normalize mount prefix to '/x/' form.

    Registry stores mounts with leading + trailing slash. Users may
    pass '/m', '/m/', 'm/', or 'm' — all should match the same mount.
    """
    s = prefix.strip("/")
    return "/" + s + "/" if s else "/"
