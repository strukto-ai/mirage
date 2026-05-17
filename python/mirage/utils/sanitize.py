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

import re

UNSAFE_CHARS = re.compile(r"[^\w\s\-.]")
MULTI_UNDERSCORE = re.compile(r"_+")
MAX_LEN = 100


def sanitize_name(name: str) -> str:
    """Sanitize a name for use in virtual paths.

    Replaces shell-unsafe characters (apostrophes, quotes, etc.)
    and spaces with underscores. Safe for use in shell commands
    without quoting.

    Args:
        name (str): raw name from API.

    Returns:
        str: sanitized name.
    """
    if not name.strip():
        return "unknown"
    cleaned = UNSAFE_CHARS.sub("_", name)
    cleaned = cleaned.replace(" ", "_")
    cleaned = MULTI_UNDERSCORE.sub("_", cleaned)
    cleaned = cleaned.strip("_")
    if len(cleaned) > MAX_LEN:
        cleaned = cleaned[:MAX_LEN]
    return cleaned


def path_safe_name(name: str) -> str:
    """Make a name safe to embed in a VFS path segment.

    Preserves the original spelling (spaces, apostrophes, emoji, etc.)
    and only replaces the path separator ``/`` with ``∕`` (U+2215)
    so the value cannot collide with a directory boundary. Use this
    for resource directory and file names where keeping the original
    display name matters more than shell ergonomics.

    Args:
        name (str): raw name from API.

    Returns:
        str: path-safe name, or "unknown" if empty.
    """
    if not name.strip():
        return "unknown"
    return name.replace("/", "∕")
