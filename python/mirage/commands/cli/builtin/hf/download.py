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

import logging

from mirage.accessor.hf_hub import (
    HfAccountAccessor,
    HfHubAccessor,
    hub_for,
)
from mirage.commands.cli.builtin.hf.accessor import (
    repo_type_of,
    require_operands,
    text_out,
)
from mirage.commands.config import Context
from mirage.commands.errors import UsageError
from mirage.commands.spec.flag_view import FlagView
from mirage.concurrency.limiter import bounded_map
from mirage.core.hf_hub.cache import (
    blob_path,
    cache_root,
    etag_of,
    link_target,
    ref_path,
    repo_folder_name,
    snapshot_dir,
    snapshot_path,
)
from mirage.core.hf_hub.client import HfHubError, hub_bytes, resolve_url
from mirage.core.hf_hub.constants import (
    ABSENT_STATUSES,
    GLOB_CHARS,
    MAX_DOWNLOAD_WORKERS,
)
from mirage.core.hf_hub.repo import (
    Absence,
    classify_absence,
    head_commit,
    revision_url,
)
from mirage.core.hf_hub.tree import (
    fetch_tree,
    filter_repo_paths,
    repo_files,
)
from mirage.core.hf_hub.tree_entry import TreeEntry
from mirage.errors.constants import MISS_ERRORS
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.workspace.files import Files

logger = logging.getLogger(__name__)

# huggingface_hub 1.16.4's answer to a download pool under one worker.
MAX_WORKERS_REFUSAL = "Invalid value. max_workers must be greater than 0"


def selected(
    tree: dict[str, TreeEntry],
    names: list[str],
    include: list[str],
    exclude: list[str],
) -> list[str]:
    """Which repo paths a download line asks for.

    Named files win outright: upstream downloads exactly those and does
    not then filter them, so --include only ever narrows a whole-repo
    download.

    Args:
        tree (dict[str, TreeEntry]): the repository listing.
        names (list[str]): filenames the line named.
        include (list[str]): glob patterns to keep.
        exclude (list[str]): glob patterns to drop.

    Returns:
        list[str]: repo-relative file paths, sorted.
    """
    files = repo_files(tree)
    if names:
        return [path for path in files if path in set(names)]
    return filter_repo_paths(files, include, exclude)


async def ensure_dir(vfs: Files, path: PathSpec) -> None:
    """Create a directory and every missing directory above it.

    Written out rather than delegated to ``mkdir -p`` because the
    parents flag is a per-backend capability: the ops factory only wires
    ``parents=True`` for backends that declare it, so a plain ``mkdir``
    of ``a/b`` fails on the rest.

    Args:
        vfs (Files): the session's files.
        path (PathSpec): absolute virtual path of the directory.
    """
    missing: list[PathSpec] = []
    current = path
    while current.virtual != "/":
        try:
            await vfs.stat(current)
            break
        except MISS_ERRORS:
            missing.append(current)
            current = current.parent
    for target in reversed(missing):
        try:
            await vfs.mkdir(target)
        except FileExistsError:
            # A parallel download fans out over files that share parents,
            # so two workers can read the same parent as missing and then
            # both create it. EEXIST here says the directory is present,
            # which is what the caller asked for; raising would fail the
            # whole gather over a race that already succeeded.
            continue


async def write_file(
    vfs: Files,
    accessor: HfHubAccessor,
    repo_path: str,
    local_dir: PathSpec,
) -> str:
    """Fetch one file and store it under the workspace directory.

    Args:
        vfs (Files): the session's files.
        accessor (HfHubAccessor): the Hub handle for the repository.
        repo_path (str): the file's repo-relative path.
        local_dir (str): where to write it, as a virtual path.

    Returns:
        str: the virtual path written.
    """
    url = resolve_url(
        accessor.endpoint,
        accessor.repo_type,
        accessor.repo_id,
        accessor.revision,
        repo_path,
    )
    data = await hub_bytes(accessor.account, url)
    target = local_dir.join(repo_path)
    await ensure_dir(vfs, target.parent)
    await vfs.write(target, data)
    return target.virtual


async def fetch_all(
    vfs: Files,
    accessor: HfHubAccessor,
    paths: list[str],
    local_dir: PathSpec,
    workers: int,
) -> list[str]:
    """Download every selected file, a bounded number at a time.

    Upstream downloads with a worker pool for the same reason: a
    repository is many small files and one round trip each is the whole
    cost. The bound is the point, not the parallelism, since the Hub
    rate-limits its resolvers; ``--max-workers`` names it the way
    upstream does.

    Args:
        vfs (Files): the session's files.
        accessor (HfHubAccessor): the Hub handle for the repository.
        paths (list[str]): repo-relative file paths to fetch.
        local_dir (str): the virtual directory to write under.
        workers (int): how many fetches may be in flight.

    Returns:
        list[str]: the virtual paths written, in the order selected.
    """

    async def one(path: str) -> str:
        return await write_file(vfs, accessor, path, local_dir)

    return await bounded_map(paths, one, workers)


async def path_exists(vfs: Files, path: PathSpec) -> bool:
    """Whether anything is at a virtual path.

    Args:
        vfs (Files): the session's files.
        path (str): the absolute virtual path.

    Returns:
        bool: whether a point lookup found something.
    """
    try:
        await vfs.stat(path)
    except MISS_ERRORS:
        return False
    return True


async def cache_file(
    vfs: Files,
    accessor: HfHubAccessor,
    entry: TreeEntry,
    cache_dir: PathSpec,
    folder: str,
    sha: str,
    force: bool,
) -> str:
    """Put one file in the cache and link it into the snapshot.

    The bytes land once, under their content address, and the snapshot
    entry is a symlink to them. That is upstream's layout and its whole
    point: two revisions of an unchanged file share one copy, and a
    second download of a file already held costs a stat rather than a
    transfer. mirage can render it because a symlink here is namespace
    state, so no backend has to support one.

    Args:
        vfs (Files): the session's files.
        accessor (HfHubAccessor): the Hub handle for the repository.
        entry (TreeEntry): the listing row for the file.
        cache_dir (str): the cache root.
        folder (str): the repository's flat directory name.
        sha (str): the commit being rendered.
        force (bool): fetch even when the blob is already held.

    Returns:
        str: the snapshot path the file now appears at.
    """
    etag = etag_of(entry)
    blob = blob_path(cache_dir, folder, etag)
    if force or not await path_exists(vfs, blob):
        url = resolve_url(
            accessor.endpoint,
            accessor.repo_type,
            accessor.repo_id,
            accessor.revision,
            entry.path,
        )
        data = await hub_bytes(accessor.account, url)
        await ensure_dir(vfs, blob.parent)
        await vfs.write(blob, data)
    link = snapshot_path(cache_dir, folder, sha, entry.path)
    if force or not await path_exists(vfs, link):
        await ensure_dir(vfs, link.parent)
        target = link_target(cache_dir, folder, sha, entry.path, etag)
        try:
            await vfs.unlink(link)
        except MISS_ERRORS:
            pass
        await vfs.symlink(link, target)
    return link.virtual


async def fetch_into_cache(
    vfs: Files,
    accessor: HfHubAccessor,
    tree: dict[str, TreeEntry],
    paths: list[str],
    cache_dir: PathSpec,
    force: bool,
    workers: int,
) -> tuple[str, list[str]]:
    """Populate the cache for one revision, bounded the same way.

    Args:
        vfs (Files): the session's files.
        accessor (HfHubAccessor): the Hub handle for the repository.
        tree (dict[str, TreeEntry]): the repository listing.
        paths (list[str]): repo-relative file paths to fetch.
        cache_dir (str): the cache root.
        force (bool): fetch even when a blob is already held.
        workers (int): how many fetches may be in flight.

    Returns:
        tuple[str, list[str]]: the snapshot directory, and the snapshot
        paths written in the order selected.
    """
    sha = await head_commit(accessor) or accessor.revision
    folder = repo_folder_name(accessor.repo_id, accessor.repo_type)
    # Only a SYMBOLIC revision earns a ref. Upstream's
    # `_cache_commit_hash_for_specific_revision` is explicit that it "does
    # nothing if `revision` is already a proper `commit_hash`", so a
    # sha-pinned download writes no ref at all; writing one produced a
    # self-referential `refs/<sha>` holding its own name, which the real
    # binary never leaves behind.
    if accessor.revision != sha:
        ref = ref_path(cache_dir, folder, accessor.revision)
        await ensure_dir(vfs, ref.parent)
        await vfs.write(ref, sha.encode())

    async def one(path: str) -> str:
        return await cache_file(
            vfs, accessor, tree[path], cache_dir, folder, sha, force
        )

    written = await bounded_map(paths, one, workers)
    return snapshot_dir(cache_dir, folder, sha).virtual, written


def refuse_variadic(names: list[str], flag: str, patterns: list[str]) -> None:
    """Refuse a line written in upstream's variadic option form.

    Upstream declares --include and --exclude as ``nargs='*'``, so
    ``--include "*.json" "*.txt"`` gives both patterns to the flag.
    mirage's grammar has no variadic option value (POSIX presents
    multiple option-arguments as one argument, so the spec layer has no
    shape for it), and the second word lands as a filename operand
    instead. Since named files win outright, that line would silently
    look for a file literally called ``*.txt`` and report no match, so
    it is refused with the spelling that works.

    Args:
        names (list[str]): the filename operands the line carried.
        flag (str): the option whose extra patterns landed here.
        patterns (list[str]): what the option itself received, so the
            message can show the whole line rewritten rather than the
            stray word twice.

    Raises:
        UsageError: an operand is glob-shaped, which no filename is.
    """
    stray = [name for name in names if any(ch in name for ch in GLOB_CHARS)]
    if not stray:
        return
    rewritten = " ".join(
        f"{flag} {pattern!r}" for pattern in [*patterns, *stray]
    )
    raise UsageError(
        f"{flag} takes one pattern per occurrence: write "
        f"{rewritten}, not several after one {flag}"
    )


async def refuse_absent(accessor: HfHubAccessor, names: list[str]) -> None:
    """Report why nothing was selected, in the Hub's own terms.

    ``download_cmd`` folds a tree walk the Hub refused (401/403/404) into
    an empty listing itself, and an empty listing says nothing about why:
    three different failures (no such repository, no such revision, no
    such file) would all read as "no files matched". So the Hub is asked
    which one it was, and the wording follows huggingface_hub's own
    errors.

    Args:
        accessor (HfHubAccessor): the Hub handle for the repository.
        names (list[str]): filenames the line named, empty when it did
            not name any.

    Raises:
        HfHubError: always; the caller reaches this only on failure.
    """
    absence = await classify_absence(accessor)
    url = revision_url(accessor)
    if absence is Absence.REPO:
        raise HfHubError(
            f"Repository Not Found for url: {url}.\n"
            "Please make sure you specified the correct `repo_id` and "
            "`repo_type`.\nIf you are trying to access a private or gated "
            "repo, make sure you are authenticated.",
            404,
            "RepoNotFound",
        )
    if absence is Absence.REVISION:
        raise HfHubError(
            f"Revision Not Found for url: {url}.\n"
            f"Invalid rev id: {accessor.revision}",
            404,
            "RevisionNotFound",
        )
    if names:
        missing = resolve_url(
            accessor.endpoint,
            accessor.repo_type,
            accessor.repo_id,
            accessor.revision,
            names[0],
        )
        raise HfHubError(
            f"Entry Not Found for url: {missing}.", 404, "EntryNotFound"
        )
    raise HfHubError(f"No files in {accessor.repo_id} matched the line", 404)


async def download_cmd(
    accessor: HfAccountAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """Download files from a repository into the workspace.

    Upstream defaults to `~/.cache/huggingface`, which a workspace has
    no equivalent of, so `--local-dir` is required rather than silently
    resolving to a directory outside the agent's world. Downloading is
    also the one verb the mount does better -- `cp /m/config.json .`
    reads the same bytes without a second copy -- so this exists for the
    repository a workspace has not mounted.
    """
    require_operands(texts, ["repo_id"])
    fl = FlagView(ctx.flags)
    local_dir = fl.as_path("local_dir")
    cache_word = cache_root(dict(ctx.env or {}))
    cache_dir = fl.as_path("cache_dir") or (
        PathSpec.from_str_path(cache_word, cwd=ctx.cwd) if cache_word else None
    )
    if not local_dir and not cache_dir:
        raise UsageError(
            "nothing to download into: pass --local-dir, or --cache-dir "
            "(or set HF_HUB_CACHE / HF_HOME), since a workspace has no "
            "home directory to default a cache under"
        )
    if ctx.vfs is None:
        raise UsageError("hf download needs a workspace to write into")
    repo_id, *names = list(texts)
    include = list(fl.as_list("include"))
    exclude = list(fl.as_list("exclude"))
    if include:
        refuse_variadic(names, "--include", include)
    if exclude:
        refuse_variadic(names, "--exclude", exclude)
    hub = hub_for(accessor, repo_id, repo_type_of(fl), fl.as_str("revision"))
    try:
        tree = await fetch_tree(hub)
    except HfHubError as exc:
        # A refused walk names the same three absences an empty one
        # does; refuse_absent asks the Hub which it was, in upstream's
        # own words. Anything else is a real failure and propagates.
        if exc.status not in ABSENT_STATUSES:
            raise
        logger.debug("hf download tree refused: %s", exc)
        tree = {}
    wanted = selected(tree, names, include, exclude)
    if not wanted:
        await refuse_absent(hub, names)
    workers = fl.as_int("max_workers", MAX_DOWNLOAD_WORKERS)
    if workers < 1:
        # Upstream fetches one named file without a pool and hands any
        # other download to a thread pool, which refuses a size under 1.
        if len(names) != 1 or names[0].endswith("/"):
            raise UsageError(MAX_WORKERS_REFUSAL, 1)
        workers = 1
    if local_dir:
        # A named local directory downloads straight into it, with no
        # cache in between; that is what upstream does too, which is why
        # --force-download only means anything in cache mode.
        base = local_dir.virtual
        written = await fetch_all(ctx.vfs, hub, wanted, local_dir, workers)
    else:
        base, written = await fetch_into_cache(
            ctx.vfs,
            hub,
            tree,
            wanted,
            cache_dir or PathSpec.from_str_path("/"),
            bool(fl.as_bool("force_download")),
            workers,
        )
    if fl.as_bool("quiet"):
        return text_out(f"{base}\n")
    body = "".join(f"{path}\n" for path in written)
    return text_out(f"{body}{base}\n")
