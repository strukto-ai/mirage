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
from operator import attrgetter

from mirage.commands.cli.builtin.hf.accessor import (
    hub_for,
    repo_type_of,
    require_operands,
    require_token,
    text_out,
)
from mirage.commands.cli.builtin.hf.download import refuse_variadic
from mirage.commands.cli.types import CLIDoors, CLIInvocation
from mirage.commands.errors import UsageError
from mirage.commands.spec.flag_view import FlagView
from mirage.core.hf_hub.admin import create_repo
from mirage.core.hf_hub.client import repo_url
from mirage.core.hf_hub.commit import Addition, commit
from mirage.core.hf_hub.config import HfConfig
from mirage.core.hf_hub.constants import (
    DEFAULT_COMMIT_MESSAGE,
    DEFAULT_IGNORE_PATTERNS,
    EMPTY_COMMIT_WARNING,
)
from mirage.core.hf_hub.tree import (
    deletions_for,
    fetch_tree,
    filter_repo_paths,
    repo_files,
)
from mirage.errors.fs import fs_strerror
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec
from mirage.utils.quote import shell_quote


async def collect(
    doors: CLIDoors, local: PathSpec
) -> tuple[list[Addition], bool]:
    """Read workspace files as additions relative to the source.

    Walk one level at a time so symlink targets outside ``local`` retain
    the names reached through the source directory.

    Args:
        doors (CLIDoors): the workspace dispatcher doors.
        local (PathSpec): the resolved source file or directory.

    Returns:
        tuple[list[Addition], bool]: sorted files and whether the source
        was a directory, which determines the destination semantics.
    """
    dispatch = doors.dispatch
    if dispatch is None:
        raise UsageError("hf upload: no workspace to read from")
    stat, _ = await dispatch("stat", local)
    if getattr(stat, "type", None) is not FileType.DIRECTORY:
        data, _ = await dispatch("read", local)
        name = posixpath.basename(local.virtual.rstrip("/"))
        return [Addition(name, bytes(data))], False
    rows: list[Addition] = []
    pending = [(local, "")]
    while pending:
        current, prefix = pending.pop()
        entries, _ = await dispatch("readdir", current)
        for entry in entries:
            child = current.join(entry)
            name = posixpath.join(
                prefix, posixpath.basename(child.virtual.rstrip("/"))
            )
            child_stat, _ = await dispatch("stat", child)
            if getattr(child_stat, "type", None) is FileType.DIRECTORY:
                pending.append((child, name))
                continue
            data, _ = await dispatch("read", child)
            rows.append(Addition(name, bytes(data)))
    return sorted(rows, key=attrgetter("path")), True


def keep(
    rows: list[Addition], include: list[str], exclude: list[str]
) -> list[Addition]:
    """Apply the line's --include and --exclude globs."""
    kept = set(filter_repo_paths([row.path for row in rows], include, exclude))
    return [row for row in rows if row.path in kept]


def in_repo_base(value: str) -> str:
    """Normalize an upload destination; ``.`` means the repository root.

    Args:
        value (str): the repo-relative operand as typed.

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
            f"path_in_repo must stay inside the repository: {value}"
        )
    return normalized.strip("/")


async def upload_cmd(
    inv: CLIInvocation[HfConfig],
) -> tuple[ByteSource | None, IOResult]:
    """Upload a workspace file or folder to a repository, as one commit."""
    require_operands(inv, ["repo_id"])
    require_token(inv, "upload")
    fl = FlagView(inv.flags)
    if inv.doors is None or inv.doors.dispatch is None:
        raise UsageError("hf upload needs a workspace to read from")
    repo_id = inv.texts[0]
    # LOCAL_PATH is path-typed, so the parser resolved it against the cwd;
    # without one, upstream's `_resolve_upload_paths` reads the file or
    # folder named after the repository (`hf upload acme/model` reads
    # `./model`) and refuses when there is none.
    source = (
        inv.paths[0]
        if inv.paths
        else PathSpec.from_str_path(repo_id.split("/")[-1], cwd=inv.cwd)
    )
    operands = [*(path.raw_path for path in inv.paths), *inv.texts[1:]]
    include = list(fl.as_list("include"))
    exclude = list(fl.as_list("exclude"))
    deletions = list(fl.as_list("delete"))
    pattern_flags = (
        ("--include", include),
        ("--exclude", exclude),
        ("--delete", deletions),
    )
    for flag, patterns in pattern_flags:
        if patterns:
            refuse_variadic(operands, flag, patterns)
    in_repo = inv.texts[1] if len(inv.texts) > 1 else ""
    try:
        collected, from_dir = await collect(inv.doors, source)
    except (FileNotFoundError, NotADirectoryError) as exc:
        raise UsageError(
            f"{shell_quote(source.raw_path)}: {fs_strerror(exc)}"
            if inv.paths
            else f"'{source.raw_path}' is not a local file or folder. "
            "Please set local_path explicitly."
        ) from None
    base = in_repo_base(in_repo)
    warnings = ""
    # Folder contents spread under path_in_repo; a single file lands at it.
    # Upstream applies filters only to folders and warns for single files.
    if from_dir:
        rows = keep(collected, include, [*exclude, *DEFAULT_IGNORE_PATTERNS])
        additions = [
            Addition(
                path=posixpath.join(base, row.path) if base else row.path,
                data=row.data,
            )
            for row in rows
        ]
    else:
        warnings = "".join(
            f"Ignoring {flag} since a single file is uploaded.\n"
            for flag, patterns in pattern_flags
            if patterns
        )
        additions = [
            Addition(path=base or row.path, data=row.data) for row in collected
        ]
    repo_type = repo_type_of(fl)
    # Upstream creates the repository if it is missing and ignores
    # --private when it already exists, so the flag picks the visibility
    # of one this line brings into being rather than changing an
    # existing repository's.
    await create_repo(
        inv.config,
        repo_id,
        repo_type,
        private=bool(fl.as_bool("private")),
        exist_ok=True,
    )
    async with hub_for(
        inv, repo_id, repo_type, fl.as_str("revision")
    ) as accessor:
        # For a folder the --delete patterns match the repo's files under
        # `path_in_repo`, and a file this commit re-adds is not deleted
        # first. A commit that would change nothing is skipped, with
        # upstream's create_commit warning.
        added = {add.path for add in additions}
        doomed = (
            [
                path
                for path in deletions_for(
                    repo_files(await fetch_tree(accessor)), deletions, base
                )
                if path not in added
            ]
            if from_dir and deletions
            else []
        )
        reply = await commit(
            accessor,
            additions=additions,
            deletions=doomed,
            message=fl.as_str("commit_message") or DEFAULT_COMMIT_MESSAGE,
            description=fl.as_str("commit_description") or "",
            create_pr=bool(fl.as_bool("create_pr")),
        )
        if reply is None:
            warnings += EMPTY_COMMIT_WARNING
        home = repo_url(inv.config.endpoint, accessor.repo_type, repo_id)
        url = f"{home}/tree/{accessor.revision}/{base}".rstrip("/")
        return text_out(f"{url}\n", warnings)
