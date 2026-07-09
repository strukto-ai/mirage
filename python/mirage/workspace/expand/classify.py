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
import shlex

from mirage.commands.spec.types import OperandKind
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.workspace.mount import MountRegistry

_FILENAME_CHAR = re.compile(r"[a-zA-Z0-9_./]")
_NON_PATH_CHAR = re.compile(r"[(){}=;|&<> ]")
_RELATIVE_PATH = re.compile(
    r"(?:\.?[a-zA-Z0-9_\-]*/)*[a-zA-Z0-9_\-]+\.[a-zA-Z0-9]+")


def _unescape_path(word: str) -> str:
    """Strip shell backslash escapes from a path string.

    Uses shlex.split which handles all POSIX shell escaping rules:
        Zecheng\\'s\\ Server  ->  Zecheng's Server
        hello\\ world         ->  hello world

    Args:
        word (str): raw path string possibly containing backslash escapes.
    """
    if "\\" not in word:
        return word
    try:
        parts = shlex.split(word)
        return parts[0] if parts else word
    except ValueError:
        return word


def classify_word(word: str, registry: MountRegistry,
                  cwd: str) -> str | PathSpec:
    """Classify an expanded word as text or PathSpec.

    Rules:
    - Absolute + glob chars -> PathSpec with pattern
    - Absolute + no glob -> PathSpec (file or directory)
    - Relative + glob chars -> resolve cwd, PathSpec
    - Relative + no glob -> plain text (never a path)
    - No mount match -> plain text
    """
    has_glob = any(ch in word for ch in ("*", "?", "["))

    if word.startswith("/"):
        # Unescape backslash-escaped paths (e.g. /data/Zecheng\'s\ Server).
        # Only for absolute paths — non-path text like sed programs
        # (N;s/\n/ /) also contains \ and / but must not be unescaped.
        if "\\" in word:
            word = _unescape_path(word)
        try:
            mount = registry.mount_for(word)
        except ValueError:
            return word
        is_dir = word.endswith("/")
        path = posixpath.normpath(word)
        if not is_dir and path + "/" == mount.prefix:
            is_dir = True
        resource_path = mount_key(path, mount.prefix.rstrip("/"))
        if has_glob:
            last_slash = path.rfind("/")
            return PathSpec(
                virtual=path,
                directory=path[:last_slash + 1],
                resource_path=resource_path,
                pattern=path[last_slash + 1:],
                resolved=False,
            )
        if is_dir:
            return PathSpec(virtual=path,
                            directory=path + "/",
                            resource_path=resource_path,
                            resolved=False)
        last_slash = path.rfind("/")
        return PathSpec(
            virtual=path,
            directory=path[:last_slash + 1],
            resource_path=resource_path,
            resolved=True,
        )

    # Relative glob: only classify if the word looks like a
    # filename pattern (has alphanumeric, dot, or slash alongside
    # glob chars). Bare globs like *, ?, [a-z] are command
    # arguments (e.g. expr 4 * 3), not path patterns.
    if has_glob and ("/" in word or not word.startswith(".")):
        if not _FILENAME_CHAR.search(word) or _NON_PATH_CHAR.search(word):
            return word
        path = posixpath.normpath(cwd.rstrip("/") + "/" + word)
        try:
            mount = registry.mount_for(path)
        except ValueError:
            return word
        last_slash = path.rfind("/")
        return PathSpec(
            virtual=path,
            directory=path[:last_slash + 1],
            resource_path=mount_key(path, mount.prefix.rstrip("/")),
            pattern=path[last_slash + 1:],
            resolved=False,
            raw_path=word,
        )

    # Relative path (no glob): resolve against cwd if the word
    # contains "/" and looks like a subdirectory path (e.g. sub/file.txt).
    # Bare filenames like "file.txt" are NOT classified — classify_word
    # has no command context, so it can't distinguish:
    #   cat file.txt   (file path — should resolve)
    #   for f in file.txt  (loop value — should stay text)
    # Users must use "./file.txt" or absolute paths for bare filenames.
    if not has_glob and "/" in word and _RELATIVE_PATH.fullmatch(word):
        if "\\" in word:
            word = _unescape_path(word)
        path = posixpath.normpath(cwd.rstrip("/") + "/" + word)
        try:
            mount = registry.mount_for(path)
        except ValueError:
            return word
        return PathSpec(
            virtual=path,
            directory=path[:path.rfind("/") + 1],
            resource_path=mount_key(path, mount.prefix.rstrip("/")),
            resolved=True,
            raw_path=word,
        )

    return word


def classify_bare_path(word: str, registry: MountRegistry,
                       cwd: str) -> str | PathSpec:
    """Classify a bare filename as a path resolved against cwd.

    Used when CommandSpec identifies an arg as PATH but classify_word
    would not classify it (e.g. bare "file.txt" without "/" prefix).
    """
    classified = classify_word(word, registry, cwd)
    if not isinstance(classified, str):
        return classified
    path = posixpath.normpath(cwd.rstrip("/") + "/" + word)
    try:
        mount = registry.mount_for(path)
    except ValueError:
        return word
    resource_path = mount_key(path, mount.prefix.rstrip("/"))
    has_glob = any(ch in word for ch in ("*", "?", "["))
    if has_glob:
        last_slash = path.rfind("/")
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
        directory=path[:path.rfind("/") + 1],
        resource_path=resource_path,
        resolved=True,
        raw_path=word,
    )


def classify_parts(
    parts: list[str],
    registry: MountRegistry,
    cwd: str,
    word_kinds: list[OperandKind | None] | None = None,
) -> list[str | PathSpec]:
    """Classify a list of expanded words.

    First element (command name) is never classified as a path.
    word_kinds (from CommandSpec, aligned with parts[1:]) decides per
    position: TEXT skips classification, PATH classifies even bare
    filenames, None falls back to the shape heuristics.
    """
    if not parts:
        return []
    result: list[str | PathSpec] = [parts[0]]
    for i, w in enumerate(parts[1:]):
        kind = (word_kinds[i]
                if word_kinds is not None and i < len(word_kinds) else None)
        if kind == OperandKind.TEXT:
            result.append(w)
        elif kind == OperandKind.PATH:
            result.append(classify_bare_path(w, registry, cwd))
        else:
            result.append(classify_word(w, registry, cwd))
    return result
