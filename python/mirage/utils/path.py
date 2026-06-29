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


def norm(path: str) -> str:
    """Normalize a virtual path to a leading-slash, no-trailing-slash key.

    Args:
        path: A virtual path string.

    Returns:
        The path with surrounding slashes collapsed to a single leading
        slash (``"foo/bar/"`` -> ``"/foo/bar"``, ``""`` -> ``"/"``).
    """
    return "/" + path.strip("/")


def parent(path: str) -> str:
    """Return the parent directory of a normalized virtual key.

    Args:
        path: A normalized virtual path (leading slash, no trailing slash).

    Returns:
        The path with its last segment removed (``"/a/b"`` -> ``"/a"``),
        or ``"/"`` when there is no parent segment.
    """
    i = path.rfind("/")
    return path[:i] if i > 0 else "/"


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
    resolved = posixpath.normpath(path)
    if resolved.startswith("//"):
        resolved = "/" + resolved.lstrip("/")
    return resolved


def expand_tilde(word: str, home: str | None) -> str:
    """Expand a leading ``~`` against the home directory.

    ``~`` alone or ``~/rest`` expands to ``home`` (or ``home/rest``).
    ``~user`` and any non-leading ``~`` are left unchanged, matching
    bash behavior when no matching user exists. When ``home`` is ``None``
    (``$HOME`` unset/empty), a leading ``~`` is left literal, mirroring
    GNU bash with no home directory.

    Args:
        word: The unexpanded word.
        home: The home directory to substitute for ``~``, or ``None``.

    Returns:
        The word with a leading ``~`` resolved, or the word unchanged.
    """
    if home is None:
        return word
    if word == "~":
        return home
    if word.startswith("~/"):
        return home.rstrip("/") + word[1:]
    return word


def rebase_display(paths: list[str], original: str,
                   display: str | None) -> list[str]:
    """Rewrite the base of walked output paths to the as-typed form.

    Used by walkers like ``find``/``grep -r``: results are absolute (start
    path plus subpath), but when the start path was typed relatively the
    output should show it that way. Maps :func:`rebase_one` over ``paths``.

    Because :func:`rebase_one` only rewrites the leading base prefix, this
    also works on formatted lines whose path is the prefix, e.g. grep's
    ``path:line``.

    Example::

        rebase_display(["/data/sub/x", "/data/y"], "/data", ".")
            -> ["./sub/x", "./y"]
        rebase_display(["/data/sub/x:hit"], "/data/sub", "sub")
            -> ["sub/x:hit"]
        rebase_display(["/data/x"], "/data", "/data")   # absolute arg
            -> ["/data/x"]                              # unchanged

    Args:
        paths (list[str]): Absolute result paths (or ``path:...`` lines)
            produced by walking ``original``.
        original (str): The resolved absolute start path.
        display (str | None): The as-typed start path, or ``None``/equal to
            leave ``paths`` unchanged (the absolute-argument case).

    Returns:
        list[str]: ``paths`` with each ``original`` base replaced by
        ``display``.
    """
    if display is None or display == original:
        return paths
    return [rebase_one(p, original, display) for p in paths]


def rebase_one(path: str, original: str, display: str | None) -> str:
    """Rewrite a single path's ``original`` base to the as-typed ``display``.

    Only the leading ``original`` prefix is rewritten, so any suffix after
    the path (e.g. grep's ``:line``) is preserved untouched.

    Example::

        rebase_one("/data/sub/x", "/data", ".")      -> "./sub/x"
        rebase_one("/data/sub", "/data/sub", "sub")  -> "sub"
        rebase_one("/data/x:hit", "/data", ".")      -> "./x:hit"
        rebase_one("/other/x", "/data", ".")         -> "/other/x"  # no match
        rebase_one("/data/x", "/data", None)         -> "/data/x"   # absolute

    Args:
        path (str): An absolute path at or under ``original`` (optionally with
            a trailing ``:...`` suffix).
        original (str): The resolved absolute base (traversal root).
        display (str | None): The as-typed base, or ``None``/equal to leave
            ``path`` unchanged.

    Returns:
        str: ``path`` with its ``original`` base replaced by ``display``.
    """
    if display is None or display == original:
        return path
    base = original.rstrip("/")
    if path == base:
        return display
    if path.startswith(base + "/"):
        return display.rstrip("/") + path[len(base):]
    return path


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
