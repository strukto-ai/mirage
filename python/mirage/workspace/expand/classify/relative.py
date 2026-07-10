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

from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.workspace.mount import MountRegistry

GLOB_CHARS = ("*", "?", "[")


def relative_spec(word: str, registry: MountRegistry,
                  cwd: str) -> str | PathSpec:
    """Build the PathSpec for a word typed relative to cwd.

    The typed word and the cwd it was typed under are two halves of one
    path: ``virtual`` resolves the pair to an absolute path, ``raw_path``
    keeps the typed spelling for display. Glob chars in the word make a
    pattern spec (unresolved); words whose resolved path has no mount
    stay plain text.

    Args:
        word (str): the word as typed (already unescaped).
        registry (MountRegistry): mount registry.
        cwd (str): working directory the word was typed under.
    """
    path = posixpath.normpath(cwd.rstrip("/") + "/" + word)
    try:
        mount = registry.mount_for(path)
    except ValueError:
        return word
    resource_path = mount_key(path, mount.prefix.rstrip("/"))
    last_slash = path.rfind("/")
    if any(ch in word for ch in GLOB_CHARS):
        return PathSpec(
            virtual=path,
            directory=path[:last_slash + 1],
            resource_path=resource_path,
            pattern=path[last_slash + 1:],
            resolved=False,
            raw_path=word,
        )
    return PathSpec(
        virtual=path,
        directory=path[:last_slash + 1],
        resource_path=resource_path,
        resolved=True,
        raw_path=word,
    )
