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
import re

from mirage.types import PathSpec
from mirage.utils.glob_walk import has_glob
from mirage.utils.key_prefix import mount_key
from mirage.workspace.expand.classify.relative import relative_spec
from mirage.workspace.mount import MountRegistry

_FILENAME_CHAR = re.compile(r"[a-zA-Z0-9_./]")
_NON_PATH_CHAR = re.compile(r"[(){}=;|&<> ]")
_RELATIVE_PATH = re.compile(
    r"(?:\.?[a-zA-Z0-9_\-]*/)*[a-zA-Z0-9_\-]+\.[a-zA-Z0-9]+")


def classify_word(word: str, registry: MountRegistry,
                  cwd: str) -> str | PathSpec:
    """Classify an expanded word as text or PathSpec.

    Every caller hands this an already-expanded word, so quote removal
    has happened and a surviving backslash is a literal character of the
    name (GNU reads a file named ``a\\b`` as ``cat '/data/a\\b'``).
    Unescaping again here corrupted both that name and any control
    character an escape had produced.

    Rules:
    - Absolute + glob chars -> PathSpec with pattern
    - Absolute + no glob -> PathSpec (file or directory)
    - Relative + glob chars -> resolve cwd, PathSpec
    - Relative + no glob -> plain text (never a path)
    - No mount match -> plain text
    """
    word_has_glob = has_glob(word)

    if word.startswith("/"):
        try:
            mount = registry.mount_for(word)
        except ValueError:
            return word
        is_dir = word.endswith("/")
        path = posixpath.normpath(word)
        if not is_dir and path + "/" == mount.prefix:
            is_dir = True
        resource_path = mount_key(path, mount.prefix.rstrip("/"))
        # `raw_path` keeps the spelling as typed, the way `relative_spec`
        # does: `virtual` has already lost any `..`, and `cd -P` has to
        # resolve the link a `..` follows before applying it.
        if word_has_glob:
            last_slash = path.rfind("/")
            return PathSpec(
                virtual=path,
                directory=path[:last_slash + 1],
                resource_path=resource_path,
                pattern=path[last_slash + 1:],
                raw_path=word,
                resolved=False,
            )
        if is_dir:
            return PathSpec(virtual=path,
                            directory=path + "/",
                            resource_path=resource_path,
                            raw_path=word,
                            resolved=False)
        last_slash = path.rfind("/")
        return PathSpec(
            virtual=path,
            directory=path[:last_slash + 1],
            resource_path=resource_path,
            raw_path=word,
            resolved=True,
        )

    # Relative glob: only classify if the word looks like a
    # filename pattern (has alphanumeric, dot, or slash alongside
    # glob chars). Bare globs like *, ?, [a-z] are command
    # arguments (e.g. expr 4 * 3), not path patterns.
    if word_has_glob and ("/" in word or not word.startswith(".")):
        if not _FILENAME_CHAR.search(word) or _NON_PATH_CHAR.search(word):
            return word
        return relative_spec(word, registry, cwd)

    # Relative path (no glob): resolve against cwd if the word
    # contains "/" and looks like a subdirectory path (e.g. sub/file.txt).
    # Bare filenames like "file.txt" are NOT classified — classify_word
    # has no command context, so it can't distinguish:
    #   cat file.txt   (file path — should resolve)
    #   for f in file.txt  (loop value — should stay text)
    # Users must use "./file.txt" or absolute paths for bare filenames.
    if not word_has_glob and "/" in word and _RELATIVE_PATH.fullmatch(word):
        return relative_spec(word, registry, cwd)

    return word
