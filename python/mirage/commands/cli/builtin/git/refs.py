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
from io import BytesIO

from dulwich.refs import DictRefsContainer, Ref, read_packed_refs_with_peeled

from mirage.commands.cli.builtin.git.constants import HEAD_REF
from mirage.commands.cli.builtin.git.io import (read_file, read_names,
                                                read_optional, remove_file,
                                                write_file)
from mirage.commands.cli.builtin.git.types import HeadRef
from mirage.runtime.types import DispatchFn

HEAD_FILE = "HEAD"
PACKED_REFS = "packed-refs"
REFS_DIR = "refs"
SYMREF_PREFIX = "ref: "
BRANCH_PREFIX = "refs/heads/"
TAG_PREFIX = "refs/tags/"


async def read_head(dispatch: DispatchFn, gitdir: str) -> HeadRef:
    """Resolve ``.git/HEAD`` to a branch name or a detached commit.

    HEAD holds either a symbolic ref (``ref: refs/heads/main``) or a raw
    object id when the checkout is detached. A ref outside ``refs/heads``
    keeps its full name, which is what git shows for a checked-out tag or
    remote-tracking ref.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        gitdir (str): absolute virtual path of the ``.git`` directory.
    """
    raw = await read_file(dispatch, posixpath.join(gitdir, HEAD_FILE))
    text = raw.decode("utf-8", errors="replace").strip()
    if not text.startswith(SYMREF_PREFIX):
        return HeadRef(branch=None, ref=None, commit=text or None)
    ref = text[len(SYMREF_PREFIX):].strip()
    branch = (ref[len(BRANCH_PREFIX):]
              if ref.startswith(BRANCH_PREFIX) else ref)
    return HeadRef(branch=branch, ref=ref, commit=None)


async def _walk_loose_refs(dispatch: DispatchFn, root: str, prefix: str,
                           refs: dict[Ref, bytes]) -> None:
    """Collect loose refs under one directory into the ref table.

    Ref names nest arbitrarily (``refs/heads/feat/git-cli``,
    ``refs/remotes/origin/main``), so the walk recurses rather than
    listing one level.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        root (str): absolute virtual path of the directory to walk.
        prefix (str): ref-name prefix accumulated so far.
        refs (dict[Ref, bytes]): ref table, updated in place.
    """
    for entry in await read_names(dispatch, root):
        name = entry.rstrip("/").rsplit("/", 1)[-1]
        if not name:
            continue
        child = posixpath.join(root, name)
        data = await read_optional(dispatch, child)
        if data is None:
            await _walk_loose_refs(dispatch, child, f"{prefix}/{name}", refs)
            continue
        value = data.strip()
        if value:
            refs[Ref(f"{prefix}/{name}".encode())] = value


async def write_ref(dispatch: DispatchFn, commondir: str, ref: str,
                    sha: bytes) -> None:
    """Point one ref at an object id, as a loose ref file.

    Always written loose, never into ``packed-refs``: git does the same
    for any ref it updates, and a loose file takes precedence over the
    packed copy, so a branch that was packed is correctly overridden
    rather than duplicated.

    Refs live in the common directory, so a branch made from a linked
    worktree is visible to the repository it was cut from, which is what
    makes ``git worktree`` share branches at all.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        commondir (str): absolute virtual path of the shared git
            directory.
        ref (str): full ref name, e.g. ``refs/heads/main``.
        sha (bytes): hex object id the ref should name.
    """
    await write_file(dispatch, posixpath.join(commondir, ref), sha + b"\n")


def without_packed(data: bytes, ref: str) -> bytes | None:
    """``packed-refs`` with one ref's lines removed, None if it held none.

    A packed ref is two lines rather than one when it is an annotated
    tag: the tag object's own id, then a ``^`` line holding the commit
    it peels to. The peeled line belongs to the ref above it, so
    dropping a ref drops the ``^`` line that follows it and nothing
    else.

    Args:
        data (bytes): the file as it stands.
        ref (str): full ref name to drop.
    """
    wanted = ref.encode()
    kept: list[bytes] = []
    dropped = False
    found = False
    for line in data.split(b"\n"):
        if line.startswith(b"^"):
            if not dropped:
                kept.append(line)
            continue
        dropped = False
        if line and not line.startswith(b"#"):
            space = line.find(b" ")
            if space != -1 and line[space + 1:].strip() == wanted:
                dropped = True
                found = True
                continue
        kept.append(line)
    return b"\n".join(kept) if found else None


async def delete_ref(dispatch: DispatchFn, commondir: str, ref: str) -> None:
    """Remove a ref, loose copy and packed copy alike.

    Both are removed because either alone can be what holds the ref,
    and removing only the loose one would report a deletion the next
    read undoes: after ``git pack-refs`` a ref exists nowhere else, and
    a force-updated one exists in both, where dropping the loose file
    would resurrect the older packed value.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        commondir (str): absolute virtual path of the shared git
            directory.
        ref (str): full ref name.
    """
    await remove_file(dispatch, posixpath.join(commondir, ref))
    path = posixpath.join(commondir, PACKED_REFS)
    data = await read_optional(dispatch, path)
    if data is None:
        return
    rewritten = without_packed(data, ref)
    if rewritten is not None:
        await write_file(dispatch, path, rewritten)


async def set_head(dispatch: DispatchFn, gitdir: str, ref: str) -> None:
    """Point HEAD at a branch, symbolically.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        gitdir (str): absolute virtual path of this checkout's git
            directory, which owns HEAD.
        ref (str): full ref name to attach to.
    """
    await write_file(dispatch, posixpath.join(gitdir, HEAD_FILE),
                     f"{SYMREF_PREFIX}{ref}\n".encode())


async def detach_head(dispatch: DispatchFn, gitdir: str, sha: bytes) -> None:
    """Point HEAD straight at a commit, detaching it from any branch.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        gitdir (str): absolute virtual path of this checkout's git
            directory.
        sha (bytes): hex object id to check out.
    """
    await write_file(dispatch, posixpath.join(gitdir, HEAD_FILE), sha + b"\n")


async def load_refs(dispatch: DispatchFn,
                    gitdir: str,
                    commondir: str | None = None) -> DictRefsContainer:
    """Read every ref a repository publishes, packed and loose.

    Both sources are needed and neither is optional: a freshly cloned
    repository keeps ``refs/remotes/origin/main`` only in
    ``packed-refs``, while a branch committed to since the last pack
    exists only as a loose file. Loose wins on a collision, which is
    git's own precedence.

    ``packed-refs`` records an annotated tag twice: the tag object's own
    id, then a ``^`` line holding the commit it points at. The peeled id
    is a lookup shortcut, not a separate ref, so it is read and
    discarded; resolving a tag loads the tag object and follows it. The
    reader that ignores peeled lines rejects the file outright, which is
    most real repositories.

    Refs come from two directories when the two differ. A linked
    worktree shares its branches with the repository it was cut from and
    keeps only its own HEAD and per-checkout refs (``refs/bisect``,
    ``refs/worktree``), so the shared table is read first and the
    worktree's own overrides it, then HEAD last of all.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        gitdir (str): absolute virtual path of this checkout's git
            directory, which owns HEAD.
        commondir (str | None): absolute virtual path of the shared git
            directory, which owns the branches. None means it is the
            same directory, which is every ordinary checkout.
    """
    shared = commondir or gitdir
    refs: dict[Ref, bytes] = {}
    packed = await read_optional(dispatch, posixpath.join(shared, PACKED_REFS))
    if packed is not None:
        for sha, name, _peeled in read_packed_refs_with_peeled(
                BytesIO(packed)):
            refs[name] = sha
    await _walk_loose_refs(dispatch, posixpath.join(shared, REFS_DIR),
                           REFS_DIR, refs)
    if gitdir != shared:
        await _walk_loose_refs(dispatch, posixpath.join(gitdir, REFS_DIR),
                               REFS_DIR, refs)
    head = await read_head(dispatch, gitdir)
    if head.ref is not None:
        refs[HEAD_REF] = f"{SYMREF_PREFIX}{head.ref}".encode()
    elif head.commit is not None:
        refs[HEAD_REF] = head.commit.encode()
    return DictRefsContainer(refs)


# Every byte git forbids anywhere in a ref name, on top of the control
# characters: the shell metacharacters that would make a name unusable
# as a revision, and the backslash.
FORBIDDEN_IN_REF = frozenset(" ~^:?*[\\")
LOCK_SUFFIX = ".lock"


def blocking_ref(known: set[Ref], ref: str) -> str | None:
    """The existing ref that stops a new one from being written.

    A ref is a path, so two of them cannot coexist when one spells a
    directory the other spells a file: with ``refs/tags/foo`` already
    there, ``refs/tags/foo/bar`` has no directory to live in, and with
    ``refs/tags/foo/bar`` there, ``refs/tags/foo`` has a directory
    standing on its name. git refuses both and names the ref already
    written; a repository can only ever hold one of the two shapes, so
    the two searches cannot both answer.

    Nothing below git's own storage can be relied on to say so. A disk
    mount raises whatever its host filesystem raises, which reaches the
    user as neither git's wording nor git's exit code, and a prefix
    store takes both keys happily and leaves a ref the loose-ref walk
    cannot find.

    Args:
        known (set[Ref]): every ref the repository holds.
        ref (str): the full ref name about to be written.

    Returns:
        str | None: the ref standing in the way, None when none does.
    """
    parts = ref.split("/")
    for depth in range(1, len(parts)):
        above = "/".join(parts[:depth])
        if Ref(above.encode()) in known:
            return above
    below = f"{ref}/".encode()
    found = sorted(name for name in known if name.startswith(below))
    return found[0].decode() if found else None


def valid_ref_name(name: str) -> bool:
    """Whether a name passes git's ref rules (``git check-ref-format``).

    The rules, in git's own order: no component may start with ``.`` or
    end with ``.lock``; ``..`` may not appear; no control character,
    space or shell metacharacter; no leading, trailing or doubled ``/``;
    no trailing ``.``; and no ``@{``. Empty is refused too. A bare ``@``
    is refused only as a whole ref, and a name here always sits below
    ``refs/``, so it passes. Pinned against git 2.50.1.

    Args:
        name (str): the name below ``refs/heads/`` or ``refs/tags/``.
    """
    if not name or name.startswith("/") or name.endswith("/"):
        return False
    if "//" in name or ".." in name or "@{" in name or name.endswith("."):
        return False
    for ch in name:
        if ord(ch) < 0x20 or ord(ch) == 0x7F or ch in FORBIDDEN_IN_REF:
            return False
    for part in name.split("/"):
        if part.startswith(".") or part.endswith(LOCK_SUFFIX):
            return False
    return True
