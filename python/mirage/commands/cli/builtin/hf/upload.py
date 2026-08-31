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
from fnmatch import fnmatch

from mirage.commands.cli.builtin.hf.accessor import (hub_for, repo_type_of,
                                                     require_operands,
                                                     require_token, text_out)
from mirage.commands.cli.builtin.hf.download import refuse_variadic
from mirage.commands.cli.types import CLIDoors, CLIInvocation
from mirage.commands.errors import UsageError
from mirage.commands.spec.types import FlagView
from mirage.core.hf_hub.admin import create_repo
from mirage.core.hf_hub.client import repo_url
from mirage.core.hf_hub.commit import Addition, commit
from mirage.core.hf_hub.config import HfConfig
from mirage.core.hf_hub.constants import DEFAULT_COMMIT_MESSAGE
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec


async def collect(doors: CLIDoors,
                  local: str) -> tuple[list[tuple[str, bytes]], bool]:
    """Read a workspace file, or every file under a workspace directory.

    Read through the op dispatcher rather than any filesystem of its
    own: an account CLI has no mount, and the path the line named is an
    unrelated workspace file, which is exactly what the dispatcher door
    is for.

    Args:
        doors (CLIDoors): the workspace doors.
        local (str): the virtual path to read.

    Returns:
        tuple[list[tuple[str, bytes]], bool]: the (path relative to
        ``local``, content) rows, and whether ``local`` was a directory.
        The caller needs that second fact: upstream reads
        ``path_in_repo`` as the destination FILE for a file source and as
        the destination FOLDER for a directory one, so a file uploaded to
        ``u.txt`` must land at ``u.txt`` and not at ``u.txt/u.txt``.

    Raises:
        UsageError: the path does not exist, or the line ran outside a
            workspace, where there is no dispatcher to read through.
    """
    dispatch = doors.dispatch
    if dispatch is None:
        raise UsageError("hf upload: no workspace to read from")
    spec = PathSpec.from_str_path(local)
    try:
        stat, _ = await dispatch("stat", spec)
    except FileNotFoundError:
        raise UsageError(f"{local}: No such file or directory") from None
    if getattr(stat, "type", None) is not FileType.DIRECTORY:
        data, _ = await dispatch("read", spec)
        return [(posixpath.basename(local.rstrip("/")), bytes(data))], False
    rows: list[tuple[str, bytes]] = []
    pending = [local.rstrip("/")]
    while pending:
        current = pending.pop()
        entries, _ = await dispatch("readdir", PathSpec.from_str_path(current))
        for entry in entries:
            child = entry if entry.startswith("/") else posixpath.join(
                current, entry)
            child_stat, _ = await dispatch("stat",
                                           PathSpec.from_str_path(child))
            if getattr(child_stat, "type", None) is FileType.DIRECTORY:
                pending.append(child)
                continue
            data, _ = await dispatch("read", PathSpec.from_str_path(child))
            rows.append((posixpath.relpath(child,
                                           local.rstrip("/")), bytes(data)))
    return sorted(rows), True


def keep(rows: list[tuple[str, bytes]], include: list[str],
         exclude: list[str]) -> list[tuple[str, bytes]]:
    """Apply the line's --include and --exclude globs."""
    if include:
        rows = [
            row for row in rows if any(
                fnmatch(row[0], pattern) for pattern in include)
        ]
    if exclude:
        rows = [
            row for row in rows
            if not any(fnmatch(row[0], pattern) for pattern in exclude)
        ]
    return rows


def in_repo_base(value: str) -> str:
    """The repo-relative directory an upload's third operand names.

    A Hub path is repo-relative with no leading slash and no ``.``
    component, so the operand is normalized rather than used verbatim:
    ``hf upload repo /local .`` means the repository root, and taking
    the dot literally stored every file under ``./``, which is a path
    the resolve endpoint then could not find.

    Args:
        value (str): the operand as typed.

    Returns:
        str: the base, "" for the repository root.

    Raises:
        UsageError: the operand climbs out of the repository.
    """
    cleaned = value.strip()
    if not cleaned:
        return ""
    normalized = posixpath.normpath(cleaned).lstrip("/")
    if normalized == "." or normalized == "/":
        return ""
    if normalized == ".." or normalized.startswith("../"):
        raise UsageError(
            f"path_in_repo must stay inside the repository: {value}")
    return normalized.strip("/")


async def upload_cmd(
        inv: CLIInvocation[HfConfig]) -> tuple[ByteSource | None, IOResult]:
    """Upload a workspace file or folder to a repository, as one commit."""
    require_operands(inv, ["repo_id"])
    require_token(inv, "upload")
    fl = FlagView(inv.flags)
    if inv.doors is None or inv.doors.dispatch is None:
        raise UsageError("hf upload needs a workspace to read from")
    repo_id = inv.texts[0]
    operands = list(inv.texts[1:])
    include = list(fl.as_list("include"))
    exclude = list(fl.as_list("exclude"))
    deletions = list(fl.as_list("delete"))
    for patterns, flag in ((include, "--include"), (exclude, "--exclude"),
                           (deletions, "--delete")):
        if patterns:
            refuse_variadic(operands, flag, patterns)
    local = operands[0] if operands else "."
    in_repo = operands[1] if len(operands) > 1 else ""
    collected, from_dir = await collect(inv.doors, local)
    rows = keep(collected, include, exclude)
    if not rows:
        raise UsageError(f"no files matched under {local}")
    base = in_repo_base(in_repo)
    # A directory source spreads under `path_in_repo`; a file source lands
    # AT it. Appending the basename either way stored `hf upload r f.txt
    # f.txt` at `f.txt/f.txt`, which the tree then reported as a directory
    # and `hf download` could not find at all.
    additions = [
        Addition(path=posixpath.join(base, name) if base else name, data=data)
        for name, data in rows
    ] if from_dir else [Addition(path=base or rows[0][0], data=rows[0][1])]
    repo_type = repo_type_of(fl)
    # Upstream creates the repository if it is missing and ignores
    # --private when it already exists, so the flag picks the visibility
    # of one this line brings into being rather than changing an
    # existing repository's.
    await create_repo(inv.config,
                      repo_id,
                      repo_type,
                      private=bool(fl.as_bool("private")),
                      exist_ok=True)
    async with hub_for(inv, repo_id, repo_type,
                       fl.as_str("revision")) as accessor:
        await commit(accessor,
                     additions=additions,
                     deletions=deletions,
                     message=fl.as_str("commit_message")
                     or DEFAULT_COMMIT_MESSAGE,
                     description=fl.as_str("commit_description") or "",
                     create_pr=bool(fl.as_bool("create_pr")))
        home = repo_url(inv.config.endpoint, accessor.repo_type, repo_id)
        url = f"{home}/tree/{accessor.revision}/{base}".rstrip("/")
        return text_out(f"{url}\n", mutated=True)
