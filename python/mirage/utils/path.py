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

import errno
import os
import posixpath
from collections.abc import Callable, Iterable
from dataclasses import replace

from mirage.types import PathSpec
from mirage.utils.fnmatch import fnmatch


def glob_prefix_match(path: str, pattern: str) -> bool:
    """Whether a glob pattern matches ``path`` or one of its ancestors.

    Segment-wise fnmatch, so ``*`` does not cross ``/`` (shell glob
    semantics, not fnmatch's flat matching). An ancestor match covers
    entries living under a matched directory.

    Args:
        path (str): absolute virtual path.
        pattern (str): absolute glob pattern.

    Example::

        glob_prefix_match("/a/x.log", "/a/*.log")    → True
        glob_prefix_match("/a/d/x.log", "/a/*.log")  → False
        glob_prefix_match("/a/d/x.log", "/a/d*")     → True
    """
    pat_segs = pattern.strip("/").split("/")
    path_segs = path.strip("/").split("/")
    if len(path_segs) < len(pat_segs):
        return False
    return all(
        fnmatch(seg, pat)
        for seg, pat in zip(path_segs[: len(pat_segs)], pat_segs)
    )


def norm(path: str) -> str:
    """Normalize a virtual path to a leading-slash, no-trailing-slash key.

    Args:
        path: A virtual path string.

    Returns:
        The path with surrounding slashes collapsed to a single leading
        slash (``"foo/bar/"`` -> ``"/foo/bar"``, ``""`` -> ``"/"``).
    """
    return "/" + path.strip("/")


def norm_dir(path: str) -> str:
    """Normalize a virtual path to its trailing-slash directory form.

    Args:
        path: A virtual path string.

    Returns:
        The path with one leading and one trailing slash
        (``"foo/bar"`` -> ``"/foo/bar/"``, ``""`` -> ``"/"``), the form
        prefix comparisons need so ``/a/`` cannot match ``/ab``.
    """
    stripped = path.strip("/")
    return "/" + stripped + "/" if stripped else "/"


def owner_prefix(prefixes: Iterable[str], path: str) -> str | None:
    """The longest mount prefix owning ``path``, or None.

    The one longest-prefix rule dispatch resolves a path by, shared so a
    registry, an ops facade, a runtime routing table and a link filter
    cannot drift: a prefix owns its own root (with or without a trailing
    slash) and everything at a path boundary below it, so ``/a/`` owns
    ``/a`` and ``/a/b`` but never ``/ab``. The winner is returned in its
    input spelling, letting each caller keep its own convention.

    Args:
        prefixes (Iterable[str]): candidate mount prefixes, any spelling.
        path (str): the virtual path to resolve.
    """
    target = norm_dir(path)
    best: str | None = None
    best_len = -1
    for prefix in prefixes:
        p = norm_dir(prefix)
        if target.startswith(p) and len(p) > best_len:
            best = prefix
            best_len = len(p)
    return best


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


def ancestors(path: str) -> list[str]:
    """Return the proper ancestors of a normalized key, outermost first.

    ``"/"`` is left out: every store treats the mount root as an existing
    directory, so it is never a component worth probing. Used by the
    store-backed backends (ram, redis) to walk a destination's parent
    chain the way ``rename(2)`` resolves it.

    Args:
        path (str): A normalized virtual path (leading slash, no trailing
            slash).

    Returns:
        list[str]: ``"/a/b/c"`` -> ``["/a", "/a/b"]``; ``"/a"`` and ``"/"``
        -> ``[]``.
    """
    parts = path.strip("/").split("/")
    return ["/" + "/".join(parts[:i]) for i in range(1, len(parts))]


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


_DOTS = (".", "..")


def dotted_spelling(word: str, base: str = "/") -> str | None:
    """The absolute spelling of a typed path whose dots a walk proves.

    The kernel resolves ``.`` and ``..`` against the directory they sit
    in, so every component in front of one has to be a directory, while
    the textual simplification a virtual path gets lets ``nope/../f``
    reach ``f`` past a missing ``nope``. This keeps the spelling a walk
    needs. A trailing slash is kept too, since ``x/`` resolves as ``x/.``
    and so names a directory. None when neither follows a named
    component: a leading climb (``../x``) only walks up from ``base``, a
    directory already, so the common ``cd ..`` and ``cat ../f`` cost
    nothing.

    Args:
        word (str): the path as typed, absolute or relative.
        base (str): the directory a relative word resolves against (the
            cwd, or tar's ``-C`` directory).
    """
    parts = [part for part in word.split("/") if part]
    lead = 0
    while lead < len(parts) and parts[lead] in _DOTS:
        lead += 1
    rest = parts[lead:]
    slashed = bool(rest) and word.endswith("/") and rest[-1] not in _DOTS
    if not slashed and not any(part in _DOTS for part in rest):
        return None
    start = resolve_path(
        "/".join(parts[:lead]) or ".", "/" if word.startswith("/") else base
    )
    return start.rstrip("/") + "/" + "/".join(rest) + "/" * slashed


def dot_prefixes(
    dotted: str, follow: Callable[[str], str] | None = None
) -> list[str]:
    """The directories a walk of ``dotted`` has to find, in walk order.

    Whatever stands in front of a ``.`` or ``..`` is where it resolves,
    so it has to be a directory; each is spelled as the walk has
    simplified it so far, and the root, always one, is left out.

    Args:
        dotted (str): an absolute spelling from :func:`dotted_spelling`.
        follow (Callable[[str], str] | None): the namespace's link
            resolution, None while it holds no link.
    """
    current = "/"
    found: list[str] = []
    for part in (p for p in dotted.split("/") if p):
        if part in _DOTS:
            if follow is not None:
                current = follow(current)
            if current != "/" and current not in found:
                found.append(current)
            if part == "..":
                current = parent(current)
            continue
        current = current.rstrip("/") + "/" + part
    return found


def walk_nodes(
    dotted: str, raw: str, follow: Callable[[str], str] | None = None
) -> list[tuple[str, str]]:
    """The intermediate names a walk enters, each with its spelling.

    What ``mkdir -p`` creates on the way and names when it cannot: GNU
    makes each component as it reaches it, so ``mkdir -p nope/../m``
    leaves ``nope`` behind as well as ``m``, and a plain file in the way
    is quoted as the operand spells it (``'a.txt'``, not the absolute
    path). Only the typed components are entered: the directory a
    relative word starts from is there already.

    Args:
        dotted (str): an absolute spelling from :func:`dotted_spelling`.
        raw (str): the operand as typed, whose prefixes spell each name.
        follow (Callable[[str], str] | None): the namespace's link
            resolution, None while it holds no link.
    """
    typed = [part for part in raw.split("/") if part]
    lead = 0
    while lead < len(typed) and typed[lead] in _DOTS:
        lead += 1
    parts = [part for part in dotted.split("/") if part]
    start = parts[: len(parts) - (len(typed) - lead)]
    current = "/" + "/".join(start)
    head = "/" if raw.startswith("/") else ""
    entered: list[tuple[str, str]] = []
    for index in range(lead, len(typed) - 1):
        part = typed[index]
        if part in _DOTS:
            if follow is not None:
                try:
                    current = follow(current)
                except CycleError:
                    return entered
            current = parent(current) if part == ".." else current
            continue
        current = current.rstrip("/") + "/" + part
        entered.append((current, head + "/".join(typed[: index + 1])))
    return entered


MAX_SYMLINK_HOPS = 40


class CycleError(OSError):
    """Raised when symlink resolution exceeds the maximum hop count.

    Mirrors POSIX ELOOP (a loop such as ``a -> b -> a`` or an unbounded
    expansion such as ``a -> a/x``) as the OSError the kernel raises.

    Args:
        path (str): the path whose resolution looped.
    """

    def __init__(self, path: str) -> None:
        super().__init__(errno.ELOOP, os.strerror(errno.ELOOP), path)


def resolve_symlinks(path: str, links: dict[str, str]) -> str:
    """Resolve symlink prefixes in ``path`` until stable.

    Walks components in order, expanding links before interpreting a later
    ``..``. Relative targets start at the link's parent; absolute targets
    restart at the root. Every caller therefore receives a canonical path.

    Args:
        path (str): An absolute virtual path.
        links (dict[str, str]): Map of link virtual-path to target.

    Returns:
        str: The path with all symlink prefixes resolved.

    Raises:
        CycleError: If resolution exceeds ``MAX_SYMLINK_HOPS`` (a loop or
            unbounded expansion), matching POSIX ELOOP.
    """
    pending = list(reversed(path.split("/")))
    resolved: list[str] = []
    hops = 0
    while pending:
        part = pending.pop()
        if part in ("", "."):
            continue
        if part == "..":
            if resolved:
                resolved.pop()
            continue
        candidate = "/" + "/".join([*resolved, part])
        target = links.get(candidate)
        if target is None:
            resolved.append(part)
            continue
        hops += 1
        if hops > MAX_SYMLINK_HOPS:
            raise CycleError(path)
        if target.startswith("/"):
            resolved.clear()
        pending.extend(reversed(target.split("/")))
    suffix = "/" if resolved and path.endswith("/") else ""
    return "/" + "/".join(resolved) + suffix


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


def respell_raw(paths: list[str], original: str, raw: str) -> list[str]:
    """Rewrite the base of walked output paths to the as-typed form.

    Used by walkers like ``find``/``grep -r``: results are absolute (start
    path plus subpath), but when the start path was typed relatively the
    output should show it that way. Maps :func:`respell_one` over ``paths``.

    Because :func:`respell_one` only rewrites the leading base prefix, this
    also works on formatted lines whose path is the prefix, e.g. grep's
    ``path:line``.

    Example::

        respell_raw(["/data/sub/x", "/data/y"], "/data", ".")
            -> ["./sub/x", "./y"]
        respell_raw(["/data/sub/x:hit"], "/data/sub", "sub")
            -> ["sub/x:hit"]
        respell_raw(["/data/x"], "/data", "/data")   # absolute arg
            -> ["/data/x"]                          # unchanged

    Args:
        paths (list[str]): Absolute result paths (or ``path:...`` lines)
            produced by walking ``original``.
        original (str): The resolved absolute start path.
        raw (str): The as-typed start path (``PathSpec.raw_path``); equal
            to ``original`` leaves ``paths`` unchanged (the
            absolute-argument case).

    Returns:
        list[str]: ``paths`` with each ``original`` base replaced by
        ``raw``.
    """
    if raw == original:
        return paths
    return [respell_one(p, original, raw) for p in paths]


def respell_one(path: str, original: str, raw: str) -> str:
    """Rewrite a single path's ``original`` base to the as-typed ``raw``.

    Only the leading ``original`` prefix is rewritten, so any suffix after
    the path (e.g. grep's ``:line``) is preserved untouched.

    Example::

        respell_one("/data/sub/x", "/data", ".")      -> "./sub/x"
        respell_one("/data/sub", "/data/sub", "sub")  -> "sub"
        respell_one("/data/x:hit", "/data", ".")      -> "./x:hit"
        respell_one("/other/x", "/data", ".")         -> "/other/x"  # no match
        respell_one("/data/x", "/data", "/data")      -> "/data/x"   # absolute
        respell_one("/data/sub/x", "/data", "")       -> "sub/x"     # bare

    Args:
        path (str): An absolute path at or under ``original`` (optionally with
            a trailing ``:...`` suffix).
        original (str): The resolved absolute base (traversal root).
        raw (str): The as-typed base (``PathSpec.raw_path``); equal to
            ``original`` leaves ``path`` unchanged. The empty string is the
            synthetic no-operand spelling (GNU ``grep -r`` with no path):
            results render as bare names relative to the base.

    Returns:
        str: ``path`` with its ``original`` base replaced by ``raw``.
    """
    if raw == original:
        return path
    base = original.rstrip("/")
    if path == base or (base == "" and path == "/"):
        return raw or "."
    if path.startswith(base + "/"):
        if raw == "":
            return path[len(base) + 1 :]
        return raw.rstrip("/") + path[len(base) :]
    return path


def drop_trailing_segments(path: str, count: int) -> str:
    """The prefix of ``path`` with ``count`` trailing segments removed.

    The ancestor counterpart of :func:`respell_one`: it names a path above
    another one while keeping the original spelling, so a relative
    argument stays relative. ``count`` is clamped so the result never
    loses every segment, which would leave an empty string where a path
    belongs.

    Example::

        drop_trailing_segments("a/b/c", 1)   -> "a/b"
        drop_trailing_segments("/x/y/z", 2)  -> "/x"
        drop_trailing_segments("a/b", 5)     -> "a/b"   # clamped
        drop_trailing_segments("a//b//c", 2) -> "a"

    Args:
        path (str): The path as typed.
        count (int): How many trailing segments to drop.
    """
    if count <= 0:
        return path
    if count >= len([part for part in path.split("/") if part]):
        return path
    head = path.rstrip("/")
    for _ in range(count):
        head = head[: head.rfind("/")].rstrip("/")
    return head or "/"


def gnu_basename(path: str, suffix: str | None = None) -> str:
    i = len(path)
    while i > 0 and path[i - 1] == "/":
        i -= 1
    if i == 0:
        return "/" if path else ""
    j = path.rfind("/", 0, i)
    base = path[j + 1 : i]
    if suffix and base != suffix and base.endswith(suffix):
        base = base[: len(base) - len(suffix)]
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


def typed_spec(word: str | PathSpec, cwd: str | PathSpec) -> PathSpec:
    """The PathSpec an operand names, its dotted spelling kept.

    A classified operand already is one. A word a builtin resolves itself
    (a relative ``ln`` name, a ``[`` operand) arrives as text, and
    resolving it with :func:`resolve_path` alone would simplify away the
    dots its walk has to prove.

    Args:
        word (str | PathSpec): the operand or an already classified path.
        cwd (str | PathSpec): base directory, retaining any unproven walk.
    """
    if isinstance(word, PathSpec):
        return word
    base = cwd.dotted or cwd.virtual if isinstance(cwd, PathSpec) else cwd
    virtual = resolve_path(word, base)
    return PathSpec(
        virtual=virtual,
        directory=virtual[: virtual.rfind("/") + 1] or "/",
        vfs_path=virtual.strip("/"),
        raw_path=word,
        dotted=dotted_spelling(posixpath.join(base, word))
        if isinstance(cwd, PathSpec) and cwd.dotted
        else dotted_spelling(word, base),
        walk_error=(
            "ENOENT"
            if word == ""
            else cwd.walk_error
            if isinstance(cwd, PathSpec) and not word.startswith("/")
            else None
        ),
    )


def join_spec(base: str | PathSpec, *parts: str) -> PathSpec:
    """Join virtual path components without discarding an unproven walk.

    Args:
        base (str | PathSpec): absolute directory or typed base.
        parts (str): path components, the last absolute component resets the base.
    """
    word = posixpath.join(*parts) if parts else ""
    scope = typed_spec(word or ".", base)
    return replace(scope, raw_path=scope.dotted or scope.virtual)


def parent_spec(path: str | PathSpec) -> PathSpec:
    """The lexical parent of a virtual path, retaining its spelled ancestors.

    Args:
        path (str | PathSpec): path whose parent will be accessed.
    """
    scope = typed_spec(path, "/")
    return typed_spec(
        posixpath.dirname((scope.dotted or scope.virtual).rstrip("/")) or "/",
        "/",
    )
