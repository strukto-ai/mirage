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

from mirage.ops.types import LinkView
from mirage.types import FileType, PathSpec


async def rm_link_refusal(
    p: PathSpec,
    links: LinkView | None,
    *,
    recursive: bool,
    force: bool,
) -> str | None:
    """GNU's refusal for an ``rm`` operand that is a slashed symlink.

    A link typed with a trailing slash is refused, never followed: the
    dispatcher deliberately left the link entry in place so the command
    can report it rather than delete what the slash was protecting. GNU
    splits the wording by what the slash resolved to and whether -r was
    given: a directory without -r is EISDIR and -f does not suppress it,
    everything else is ENOTDIR and -f does.

    Returns None when the operand is not a slashed link, or when -f
    silences the refusal; the caller then proceeds as usual.

    Args:
        p (PathSpec): the operand, as typed.
        links (LinkView | None): the namespace's symlink facts.
        recursive (bool): whether -r/-R was given.
        force (bool): whether -f was given.
    """
    if links is None or not p.raw_path.endswith("/"):
        return None
    if links.stat_at(p.virtual) is None:
        return None
    target = await links.target_stat(p.virtual)
    if (target is not None and target.type == FileType.DIRECTORY
            and not recursive):
        return f"rm: cannot remove '{p.raw_path}': Is a directory"
    if force:
        return None
    return f"rm: cannot remove '{p.raw_path}': Not a directory"


def is_slashed_link(p: PathSpec, links: LinkView | None) -> bool:
    """Whether an operand typed with a trailing slash names a symlink.

    Args:
        p (PathSpec): the operand, as typed.
        links (LinkView | None): the namespace's symlink facts.
    """
    return (links is not None and p.raw_path.endswith("/")
            and links.stat_at(p.virtual) is not None)


async def mkdir_link_refusal(
    p: PathSpec,
    links: LinkView | None,
    *,
    parents: bool,
) -> tuple[bool, str | None]:
    """GNU's refusal for a ``mkdir`` operand occupied by a symlink.

    mkdir(2) lstats the name it is about to create, so a symlink sitting
    there is EEXIST however it was spelled -- no backend can see the
    link, so the name plane has to answer. -p is satisfied only when the
    link already leads to a directory; pointing at a file or at nothing
    still collides (GNU ``mkdir -p dangle`` is "File exists", not a
    fresh directory at the link's target).

    Returns ``(taken, message)``: ``taken`` says the name is already
    occupied by a link, so the caller must not create anything, and
    ``message`` is the line to report (None when -p is already
    satisfied and the operand is simply skipped).

    Args:
        p (PathSpec): the operand, as typed.
        links (LinkView | None): the namespace's symlink facts.
        parents (bool): whether -p was given.
    """
    if links is None or links.stat_at(p.virtual) is None:
        return False, None
    target = await links.target_stat(p.virtual)
    if parents and target is not None and target.type == FileType.DIRECTORY:
        return True, None
    return True, f"mkdir: cannot create directory '{p.raw_path}': File exists"


__all__ = ["is_slashed_link", "mkdir_link_refusal", "rm_link_refusal"]
