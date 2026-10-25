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


from collections.abc import Iterable, Mapping, Sequence

from mirage.rs.policy import (
    admission_matcher,
    from_units,
    link_trace_wire,
    units,
    visibility_matcher,
)
from mirage.types import HiddenPaths, Visibility
from mirage.utils.path import trace_symlinks


def is_glob(entry: str) -> bool:
    """Whether a document entry is a pattern (any of ``*``, ``?``, ``[``).

    Args:
        entry (str): one entry of a ``hide`` list or a rule's ``paths``.
    """
    return admission_matcher(None).ask("is_glob", entry=units(entry)) is True


def classify_paths(entries: Iterable[str]) -> HiddenPaths | None:
    """Compile document path entries into the matcher's shape.

    Glob = pattern, plain = exact subtree, in the order written; the
    same split serves ``paths.hide`` and a ``CommandRule``'s ``paths``
    so both planes match the same way. None when there
    is nothing to match, which is what "unrestricted" reads as.

    Args:
        entries (Iterable[str]): the document's entries.
    """
    scope = admission_matcher(None).ask(
        "classify_paths", entries=[units(v) for v in entries]
    )
    if not scope["paths"] and not scope["patterns"]:
        return None
    return HiddenPaths(
        paths=tuple(from_units(v) for v in scope["paths"]),
        patterns=tuple(from_units(v) for v in scope["patterns"]),
    )


def show_head(entry: str) -> str:
    """The place a show entry anchors to: the entry itself when exact,
    the fixed directory above its first glob segment when a pattern.

    Args:
        entry (str): a show entry's path as written.
    """
    return from_units(
        admission_matcher(None).ask("show_head", entry=units(entry))
    )


def path_visible(vis: Visibility | None, virtual: str) -> bool:
    """Whether one session's path axis leaves this virtual path
    visible: the whole composition law for the VFS axis.

    Three steps, each the anchor-depth rule: no hide covers the path
    and it is visible; a show covers it more deeply than the deepest
    hide and it is visible (hide wins the tie); and a hidden directory
    stays visible when a visible show anchors strictly below it, so the
    road to a carve-out exists (``hide /repo`` + ``show /repo/public``
    keeps ``/repo`` listable, holding only the carve-out).

    Args:
        vis (Visibility | None): the session's visibility, None for an
            unrestricted one.
        virtual (str): absolute virtual path to test.
    """
    if vis is None or vis.paths is None:
        return True
    return (
        visibility_matcher(vis).ask("path_visible", path=units(virtual))
        is True
    )


def move_reveals(vis: Visibility | None, src: str, dst: str) -> bool:
    """Whether relocating ``src`` to ``dst`` could surface a hidden path.

    The reveal half of the subtree law: a session's mutation may destroy
    what it cannot see (``rm -r``, a remnant ``rmdir``), but may never
    reveal it, and a rename or a native directory copy is the relocation
    that would. A source the session reaches only through a show below
    it is hidden itself, so whatever the show does not reopen reveals
    wherever the session sees ``dst``. Beyond that, three arms, one per
    entry kind. A component pattern
    follows the name wherever the content goes, so it never reveals. An
    exact entry anchored strictly below ``src`` re-anchors to ``dst``
    plus its suffix, and reveals when the session would see that mapped
    path (a show anchored below the mapped path counts, through
    ``path_visible``'s own carve-out rule). An anchored pattern's
    coverage does not move with the content, so any pattern whose match
    space could reach below ``src`` refuses, failing toward refusal the
    way ``readonly_below`` blames a pattern.

    Spec-only: nothing here stats. A ``src`` that is a regular file has
    nothing below it to re-anchor, so the callers gate this check on the
    source being a directory (statting where they can, failing toward
    refusal where they cannot).

    Args:
        vis (Visibility | None): the session's visibility, None for an
            unrestricted one.
        src (str): absolute virtual path being moved or copied.
        dst (str): absolute virtual path it would land at.
    """
    if vis is None or vis.paths is None:
        return False
    return (
        visibility_matcher(vis).ask(
            "move_reveals", src=units(src), dst=units(dst)
        )
        is True
    )


def leads_hidden(
    vis: Visibility | None, virtual: str, links: Mapping[str, str]
) -> bool:
    """Whether a visible name leads where the session cannot see: a
    link the walk follows names a hidden path.

    The walk judges what a link brings in, not the typed path, which
    the caller judges whole (a carve-out keeps its hidden parents
    traversable): each link's own path, every name a stored target
    spells before a later ``..`` takes it back (``/data/secret/../pub``
    still prints ``secret``), and the place the walk lands. Such a
    link is as hidden as its target, since its listing row,
    ``readlink`` and ``ls -l`` would print the hidden name; a link that
    leads nowhere (dangling, or a loop) leads nowhere hidden.

    Args:
        vis (Visibility | None): the session's visibility, None for an
            unrestricted one.
        virtual (str): absolute virtual path, already visible itself.
        links (Mapping[str, str]): every link and its stored target.
    """
    if vis is None or not links:
        return False
    return (
        visibility_matcher(vis).ask(
            "link_trace_hidden",
            trace=link_trace_wire(trace_symlinks(virtual, links)),
        )
        is True
    )


def visible_links(
    vis: Visibility | None, paths: Sequence[str], links: Mapping[str, str]
) -> tuple[bool, ...]:
    if vis is None or vis.paths is None:
        return (True,) * len(paths)
    matcher = visibility_matcher(vis)
    shown = [
        keep is True
        for keep in matcher.ask(
            "visible_links",
            candidates=[{"path": units(path), "trace": []} for path in paths],
        )
    ]
    checked = iter(
        matcher.ask(
            "visible_links",
            candidates=[
                {
                    "path": units(path),
                    "trace": link_trace_wire(trace_symlinks(path, links)),
                }
                for path, keep in zip(paths, shown, strict=True)
                if keep
            ],
        )
    )
    return tuple(next(checked) is True if keep else False for keep in shown)


def hidden_under(vis: Visibility | None, virtual: str) -> bool:
    """Whether the session could hide anything at or under this path.

    For the view a native walk asks before it trusts the raw tree: a
    hide at or under the path, or a pattern whose head could reach it.

    Args:
        vis (Visibility | None): the session's visibility, None for an
            unrestricted one.
        virtual (str): absolute virtual path of the walk's start point.
    """
    if vis is None or vis.paths is None:
        return False
    return (
        visibility_matcher(vis).ask("hides_intersect", path=units(virtual))
        is True
    )


def var_hidden(vis: Visibility | None, name: str) -> bool:
    """Whether the session hides this variable name.

    Args:
        vis (Visibility | None): the session's visibility, None for an
            unrestricted one.
        name (str): variable name to test.
    """
    if vis is None or vis.vars is None:
        return False
    return visibility_matcher(vis).ask("var_hidden", name=units(name)) is True
