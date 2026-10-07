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

from mirage.core.hf_hub.constants import REPO_ID_SEPARATOR
from mirage.core.hf_hub.tree_entry import TreeEntry
from mirage.types import PathSpec


def repo_folder_name(repo_id: str, repo_type: str) -> str:
    """The one flat directory a repository's cache lives under.

    Upstream's own spelling (``file_download.repo_folder_name``): the
    plural kind and the two halves of the id joined by ``--``, so
    ``julien-c/EsperBERTo-small`` as a model is
    ``models--julien-c--EsperBERTo-small``. Flattening is the point: a
    namespace holding a slash would otherwise nest, and two repos could
    collide across kinds.

    Args:
        repo_id (str): "namespace/name".
        repo_type (str): "model", "dataset" or "space".

    Returns:
        str: the directory name, with no path separators in it.
    """
    return REPO_ID_SEPARATOR.join([f"{repo_type}s", *repo_id.split("/")])


def etag_of(entry: TreeEntry) -> str:
    """The name a file's bytes are cached under.

    Upstream keys a blob by the ETag the resolve endpoint answered,
    which is the LFS sha256 for a pointer-backed file and the git blob
    oid for an ordinary one. Both are content addresses, which is what
    makes the blob shareable between revisions: two snapshots of an
    unchanged file link to one blob.

    Args:
        entry (TreeEntry): the listing row for the file.

    Returns:
        str: the blob's name.
    """
    return entry.lfs_oid or entry.oid


def blob_path(cache_dir: PathSpec, folder: str, etag: str) -> PathSpec:
    """Where one file's bytes live, shared across every snapshot."""
    return cache_dir.join(folder, "blobs", etag)


def snapshot_dir(cache_dir: PathSpec, folder: str, sha: str) -> PathSpec:
    """The directory one commit's tree is rendered under."""
    return cache_dir.join(folder, "snapshots", sha)


def snapshot_path(
    cache_dir: PathSpec, folder: str, sha: str, repo_path: str
) -> PathSpec:
    """Where one file appears within a commit's rendered tree."""
    return snapshot_dir(cache_dir, folder, sha).join(repo_path)


def ref_path(cache_dir: PathSpec, folder: str, revision: str) -> PathSpec:
    """The file recording which commit a branch or tag points at."""
    return cache_dir.join(folder, "refs", revision)


def link_target(
    cache_dir: PathSpec, folder: str, sha: str, repo_path: str, etag: str
) -> str:
    """The relative target a snapshot entry points at.

    Relative, not absolute, because upstream's cache is relocatable: a
    whole cache directory can be moved or copied and every link still
    resolves. Derived rather than counted out, so a nested path cannot
    get the number of ``..`` hops wrong.

    Args:
        cache_dir (str): the cache root.
        folder (str): the repository's flat directory name.
        sha (str): the commit the snapshot renders.
        repo_path (str): the file's repo-relative path.
        etag (str): the blob's name.

    Returns:
        str: the link target, relative to the entry's own directory.
    """
    entry = snapshot_path(cache_dir, folder, sha, repo_path)
    return posixpath.relpath(
        blob_path(cache_dir, folder, etag).virtual,
        posixpath.dirname(entry.virtual),
    )


def cache_root(env: dict[str, str] | None) -> str | None:
    """The cache root the session names, in upstream's own order.

    Upstream reads ``HF_HUB_CACHE`` first and falls back to
    ``HF_HOME/hub``, then to ``~/.cache/huggingface/hub``. A workspace
    has no home directory, so the last step is the one that cannot be
    taken and the caller reports that rather than inventing a path.

    Args:
        env (dict[str, str] | None): the session environment.

    Returns:
        str | None: the cache root, or None when nothing named one.
    """
    if not env:
        return None
    direct = env.get("HF_HUB_CACHE")
    if direct:
        return direct
    home = env.get("HF_HOME")
    return posixpath.join(home, "hub") if home else None
