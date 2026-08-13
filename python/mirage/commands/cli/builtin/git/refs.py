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
HEAD_REF = Ref(b"HEAD")


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


async def delete_ref(dispatch: DispatchFn, commondir: str, ref: str) -> None:
    """Remove a loose ref file.

    Only the loose copy is removed. A ref that also sits in
    ``packed-refs`` would come back, which is a real gap rather than a
    silent one: ``branch -d`` refuses below unless the loose file is
    what actually holds the branch.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        commondir (str): absolute virtual path of the shared git
            directory.
        ref (str): full ref name.
    """
    await remove_file(dispatch, posixpath.join(commondir, ref))


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
