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

from mirage.ops.types import StatPath
from mirage.types import FileStat, PathSpec
from mirage.utils.dates import iso_timestamp, timestamp_iso
from mirage.utils.path import CycleError
from mirage.workspace.expand.classify.path import classify_bare_path
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.mount.namespace.overlay import merge_overlay_stat

NEWER = "-newer"
NEWERMT = "-newermt"


def missing_reference_line(ref: str) -> bytes:
    """GNU's line for a ``-newer`` reference that does not exist.

    Args:
        ref (str): the reference as typed.
    """
    return f"find: '{ref}': No such file or directory\n".encode()


def loop_reference_line(ref: str) -> bytes:
    """GNU's line for a ``-newer`` reference that is a symlink loop,
    under a policy that follows it.

    Args:
        ref (str): the reference as typed.
    """
    return f"find: '{ref}': Too many levels of symbolic links\n".encode()


async def reference_stat(
    virtual: str,
    stat_path: StatPath,
    namespace: Namespace | None,
    follow: bool,
) -> FileStat | None:
    """The stat a ``-newer`` reference compares by, or None when absent.

    GNU reads the reference with the link policy the leading option
    set: ``-P`` (the default) takes a symlink's own mtime, ``-H`` and
    ``-L`` take its target's. A link lives in the namespace, so its own
    row comes from there and never touches a backend, which is also
    what makes a loop under ``-P`` an ordinary reference. Under a
    following policy the target is resolved through the namespace,
    which raises on a loop, and a dangling one falls back to the link's
    own row, as GNU's stat-then-lstat does.

    Args:
        virtual (str): the reference's absolute virtual path.
        stat_path (StatPath): the dispatcher's stat probe.
        namespace (Namespace | None): the name plane, whose node table
            holds the links and whose attr overlay may hold the mtime.
        follow (bool): whether the leading option follows links.

    Raises:
        CycleError: the reference is a loop and ``follow`` is set.
    """
    if namespace is None:
        return await stat_path(virtual)
    own = namespace.link_stat_at(virtual)
    if own is None:
        stat = await stat_path(virtual)
        if stat is None:
            return None
        return merge_overlay_stat(namespace.meta_for(virtual), stat)
    if not follow:
        return own
    target = namespace.follow(virtual)
    stat = await stat_path(target)
    if stat is None:
        return own
    return merge_overlay_stat(namespace.meta_for(target), stat)


async def resolve_newer_refs(
    tokens: list[str],
    refs: list[str],
    registry: MountRegistry,
    cwd: str,
    stat_path: StatPath,
    namespace: Namespace | None = None,
    follow: bool = False,
) -> tuple[list[str], bytes | None]:
    """Rewrite every ``-newer FILE`` in an expression into ``-newermt``.

    A backend's find op sees the expression as tokens and can stat
    nothing outside its own mount, while the reference may live on any
    mount and carry a namespace-overlay mtime (a ``touch -d`` on a
    backend that stores none). So the executor resolves each reference
    through the dispatcher once, before any backend parses the
    expression, and hands down a timestamp that needs no further I/O.
    A reference that does not exist is GNU's error, exit 1, and no walk
    runs; so is a symlink loop under ``-H`` or ``-L``, in GNU's other
    words.

    Args:
        tokens (list[str]): the expression tokens as typed.
        refs (list[str]): the reference operands, in expression order.
        registry (MountRegistry): mount registry, for classification.
        cwd (str): the session's working directory.
        stat_path (StatPath): the dispatcher's stat probe.
        namespace (Namespace | None): the name plane, whose node table
            holds the links and whose attr overlay may hold the
            reference's mtime.
        follow (bool): whether the leading ``-H``/``-L`` follows a
            reference that is a symlink; ``-P``, the default, reads the
            link itself.

    Returns:
        The rewritten tokens and None, or the tokens untouched and the
        error line for the first reference that does not exist.
    """
    times: list[str] = []
    for ref in refs:
        scope = classify_bare_path(ref, registry, cwd)
        virtual = scope.virtual if isinstance(scope, PathSpec) else ref
        try:
            stat = await reference_stat(virtual, stat_path, namespace, follow)
        except CycleError:
            return tokens, loop_reference_line(ref)
        if stat is None:
            return tokens, missing_reference_line(ref)
        # A reference with no reported mtime is never "older" than
        # anything: the epoch bound admits every dated entry, which is
        # the most a backend without times can honestly say.
        times.append(timestamp_iso(_modified_or_epoch(stat.modified)) or "")
    rewritten: list[str] = []
    i = 0
    n = 0
    while i < len(tokens):
        if tokens[i] == NEWER and i + 1 < len(tokens) and n < len(times):
            rewritten.extend((NEWERMT, times[n]))
            n += 1
            i += 2
            continue
        rewritten.append(tokens[i])
        i += 1
    return rewritten, None


def _modified_or_epoch(modified: str | None) -> float:
    ts = iso_timestamp(modified)
    return ts if ts is not None else 0.0
