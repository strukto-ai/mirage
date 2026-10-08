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
) -> tuple[list[tuple[str, bytes]], bool]:
    """Read a workspace file, or every file under a workspace directory.

    Read through the op dispatcher rather than any filesystem of its
    own: an account CLI has no mount, and the path the line named is an
    unrelated workspace file, which is exactly what the dispatcher door
    is for.

    A file is named by where it sits under ``local``, one walked level
    at a time, never by its own absolute path: through a symlink the
    listing answers with the target's paths, which are not under
    ``local`` at all.

    Args:
        doors (CLIDoors): the workspace doors.
        local (PathSpec): the source, as the line resolved it.

    Returns:
        tuple[list[tuple[str, bytes]], bool]: the (path relative to
        ``local``, content) rows, and whether ``local`` was a directory.
        The caller needs that second fact: upstream reads
        ``path_in_repo`` as the destination FILE for a file source and as
        the destination FOLDER for a directory one, so a file uploaded to
        ``u.txt`` must land at ``u.txt`` and not at ``u.txt/u.txt``.

    Raises:
        UsageError: the line ran outside a workspace, where there is no
            dispatcher to read through.
        FileNotFoundError: the source does not exist (an empty spelling
            included, which the parser marks as such).
    """
    dispatch = doors.dispatch
    if dispatch is None:
        raise UsageError("hf upload: no workspace to read from")
    stat, _ = await dispatch("stat", local)
    if getattr(stat, "type", None) is not FileType.DIRECTORY:
        data, _ = await dispatch("read", local)
        name = posixpath.basename(local.virtual.rstrip("/"))
        return [(name, bytes(data))], False
    rows: list[tuple[str, bytes]] = []
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
            rows.append((name, bytes(data)))
    return sorted(rows), True


def keep(
    rows: list[tuple[str, bytes]], include: list[str], exclude: list[str]
) -> list[tuple[str, bytes]]:
    """Apply the line's --include and --exclude globs."""
    kept = set(filter_repo_paths([name for name, _ in rows], include, exclude))
    return [row for row in rows if row[0] in kept]


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
    for patterns, flag in (
        (include, "--include"),
        (exclude, "--exclude"),
        (deletions, "--delete"),
    ):
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
    # A directory source spreads under `path_in_repo`, filtered the way
    # upload_folder filters (git and hub cache folders always left out);
    # a file source lands AT it, and upstream ignores the filters for
    # one, with a warning each. Appending the basename either way stored
    # `hf upload r f.txt f.txt` at `f.txt/f.txt`, which the tree then
    # reported as a directory and `hf download` could not find at all.
    if from_dir:
        rows = keep(collected, include, [*exclude, *DEFAULT_IGNORE_PATTERNS])
        additions = [
            Addition(
                path=posixpath.join(base, name) if base else name, data=data
            )
            for name, data in rows
        ]
    else:
        given = (
            ("--include", include),
            ("--exclude", exclude),
            ("--delete", deletions),
        )
        warnings = "".join(
            f"Ignoring {flag} since a single file is uploaded.\n"
            for flag, patterns in given
            if patterns
        )
        name, data = collected[0]
        additions = [Addition(path=base or name, data=data)]
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
