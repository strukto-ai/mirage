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

import re

from mirage.commands.cli.builtin.git.io import read_optional
from mirage.commands.cli.builtin.git.types import MailmapEntry, RepoLocation
from mirage.commands.spec.flag_view import FlagView
from mirage.runtime.types import DispatchFn
from mirage.utils.path import join_spec

MAILMAP_LINE = re.compile(
    r"^\s*([^<>]*?)\s*<([^<>]+)>(?:\s*([^<>]*?)\s*<([^<>]*)>)?"
)
IDENTITY = re.compile(r"(.*?)\s*<([^<>]*)>")


def parse_mailmap(text: str) -> tuple[MailmapEntry, ...]:
    """Read Git's four mailmap identity forms.

    Pinned against git 2.47.3 (Debian stable) and 2.50.1: only a ``#``
    in the first column starts a comment, and the second email may be
    empty (``<>``) while the first may not.

    Args:
        text (str): worktree mailmap contents.
    """
    entries = []
    for line in text.splitlines():
        if line.startswith("#"):
            continue
        match = MAILMAP_LINE.match(line)
        if match is None:
            continue
        name, email, old_name, old_email = match.groups()
        entries.append(
            MailmapEntry(
                (email if old_email is None else old_email).lower(),
                old_name.lower() if old_name else None,
                name or None,
                None if old_email is None else email,
            )
        )
    return tuple(entries)


def mapped_identity(identity: str, entries: tuple[MailmapEntry, ...]) -> str:
    """Map one ``Name <email>`` identity the way git's ``map_user`` does.

    An entry naming both the recorded name and email wins outright, the
    last such line replacing any earlier one. Without one, the entries
    naming the email alone apply, each later line overriding the part
    it spells.

    Args:
        identity (str): recorded name and email.
        entries (tuple[MailmapEntry, ...]): mailmap entries in file order.
    """
    match = IDENTITY.match(identity)
    if match is None:
        return identity
    name, email = match.groups()
    simple_name = simple_email = None
    specific: MailmapEntry | None = None
    for entry in entries:
        if entry.email != email.lower():
            continue
        if entry.name is None:
            simple_name = entry.mapped_name or simple_name
            simple_email = entry.mapped_email or simple_email
        elif entry.name == name.lower():
            specific = entry
    if specific is not None:
        simple_name, simple_email = specific.mapped_name, specific.mapped_email
    return f"{simple_name or name} <{simple_email or email}>"


async def load_mailmap(
    dispatch: DispatchFn, location: RepoLocation
) -> tuple[MailmapEntry, ...]:
    """Read the worktree mailmap through the workspace data plane.

    Args:
        dispatch (DispatchFn): op dispatcher.
        location (RepoLocation): discovered repository.
    """
    data = await read_optional(
        dispatch, join_spec(location.worktree, ".mailmap")
    )
    return parse_mailmap((data or b"").decode("utf-8", "replace"))


def use_mailmap(fl: FlagView, enabled: bool) -> bool:
    """Apply explicit mailmap switches in command-line order.

    Args:
        fl (FlagView): spec-bound options.
        enabled (bool): configured default.
    """
    for key, _ in fl.occurrences(
        "mailmap", "use_mailmap", "no_mailmap", "no_use_mailmap"
    ):
        enabled = not key.startswith("no_")
    return enabled
