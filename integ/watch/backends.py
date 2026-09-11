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

import base64
import importlib.util
import os
import tempfile
import uuid
from pathlib import Path
from types import ModuleType
from typing import Any, Awaitable, Callable

import aiohttp
from pydantic import SecretStr

from mirage import MountMode, Workspace
from mirage.core.github.client import github_request
from mirage.core.github.read import read_bytes
from mirage.core.github.tree import fetch_tree
from mirage.core.github.tree_entry import TreeEntry
from mirage.resource.box import BoxConfig, BoxResource
from mirage.resource.disk import DiskResource
from mirage.resource.dropbox import DropboxConfig, DropboxResource
from mirage.resource.gdrive import GoogleDriveResource
from mirage.resource.gdrive.config import GoogleDriveConfig
from mirage.resource.github import GitHubConfig, GitHubResource
from mirage.resource.gridfs import GridFSConfig, GridFSResource
from mirage.resource.hf_buckets import HfBucketsConfig, HfBucketsResource
from mirage.resource.onedrive import OneDriveConfig, OneDriveResource
from mirage.resource.s3 import S3Config, S3Resource
from mirage.resource.ssh import SSHConfig, SSHResource

SERVER_DIR = Path(__file__).resolve().parents[1] / "server"
GITHUB_OWNER = "integ"
GITHUB_REPO = "watch"
GITHUB_REF = "main"

Pair = tuple[Workspace, "WorkspaceWriter | GitHubWriter"]
ResourceFactory = Callable[[], Any]


class WorkspaceWriter:
    """External writer backed by a second workspace over one backend.

    The batteries need a mutation the watched workspace did not make, so
    its caches are genuinely stale when the event lands. A second
    workspace over the same backend is exactly that: its own cache
    manager, its own index, the same bytes underneath. It also gives
    every backend one writer instead of one adapter per API, which is
    what lets the same cases run against all of them.

    The surface mirrors the opendal operator the Nextcloud battery
    writes through, so ``_mutate`` and ``_seed`` need no branch.
    """

    def __init__(self, ws: Workspace, mount: str) -> None:
        """Args:
            ws (Workspace): Writer workspace, distinct from the watched
                one.
            mount (str): Mount prefix both workspaces share.
        """
        self._ws = ws
        self._mount = mount.rstrip("/")

    def _virtual(self, path: str) -> str:
        return f"{self._mount}/{path.strip('/')}"

    async def create_dir(self, path: str) -> None:
        """Args:
            path (str): Mount-relative directory, trailing slash
                optional.
        """
        await self._ws.execute(f"mkdir -p {self._virtual(path)}")

    async def write(self, path: str, data: bytes) -> None:
        """Args:
            path (str): Mount-relative file path.
            data (bytes): Content to store.
        """
        key = path.strip("/")
        parent = key.rsplit("/", 1)[0]
        if parent != key:
            await self.create_dir(parent)
        await self._ws.fs.write(self._virtual(key), data)

    async def delete(self, path: str) -> None:
        """Args:
            path (str): Mount-relative path; a directory goes with its
                subtree, matching opendal's delete.
        """
        await self._ws.execute(f"rm -rf {self._virtual(path)}")

    async def remove_all(self, path: str) -> None:
        """Args:
            path (str): Mount-relative subtree to empty.
        """
        await self.delete(path)

    async def rename(self, path: str, to: str) -> None:
        """Args:
            path (str): Mount-relative source.
            to (str): Mount-relative destination.
        """
        await self._ws.fs.rename(self._virtual(path), self._virtual(to))

    async def close(self) -> None:
        await self._ws.close()


class GitHubWriter:
    """External writer over GitHub's own contents API.

    Every other backend here is written through a second workspace,
    which needs the resource to have write ops. GitHub's has none, and
    should not: a mount is a read view of one ref, and a ref changes by
    being committed to. So this speaks what a committer speaks, ``PUT``
    and ``DELETE`` on ``/contents/{path}``, each carrying the blob sha
    it replaces, which is also the strongest fingerprint the differ
    ever compares.

    Git stores no directory object, so ``create_dir`` is a no-op: a
    directory exists exactly as long as a path runs through it. That is
    also why ``remove_all`` enumerates the tree rather than deleting
    one marker, and why ``rename`` is a write plus a delete.
    """

    def __init__(self, config: GitHubConfig, owner: str, repo: str,
                 ref: str) -> None:
        """Args:
            config (GitHubConfig): Token and API base of the fake.
            owner (str): Repository owner.
            repo (str): Repository name.
            ref (str): Branch the mount is pinned to.
        """
        self._config = config
        self._owner = owner
        self._repo = repo
        self._ref = ref

    async def _tree(self) -> dict[str, TreeEntry]:
        """The ref's recursive tree, which names every blob's sha."""
        tree, _truncated = await fetch_tree(self._config, self._owner,
                                            self._repo, self._ref)
        return tree

    async def _commit(self, method: str, path: str, body: dict[str,
                                                               str]) -> None:
        """Send one contents-API call against the pinned branch.

        Args:
            method (str): "PUT" or "DELETE".
            path (str): Repo-relative path.
            body (dict[str, str]): Call-specific fields.
        """
        await github_request(
            self._config.token,
            method,
            f"/repos/{self._owner}/{self._repo}/contents/{path}", {
                "branch": self._ref,
                "message": f"integ watch {path}",
                **body,
            },
            base_url=self._config.base_url)

    async def create_dir(self, path: str) -> None:
        """No-op: git has no directory object to create.

        Args:
            path (str): Mount-relative directory, ignored.
        """

    async def write(self, path: str, data: bytes) -> None:
        """Args:
            path (str): Mount-relative file path.
            data (bytes): Content to commit.
        """
        key = path.strip("/")
        entry = (await self._tree()).get(key)
        body = {"content": base64.b64encode(data).decode("ascii")}
        if entry is not None:
            body["sha"] = entry.sha
        await self._commit("PUT", key, body)

    async def delete(self, path: str) -> None:
        """Args:
            path (str): Mount-relative file path.
        """
        entry = (await self._tree()).get(path.strip("/"))
        if entry is not None:
            await self._commit("DELETE", entry.path, {"sha": entry.sha})

    async def remove_all(self, path: str) -> None:
        """Args:
            path (str): Mount-relative subtree to empty.
        """
        stem = path.strip("/")
        base = f"{stem}/" if stem else ""
        for entry in (await self._tree()).values():
            if entry.type == "tree" or not entry.path.startswith(base):
                continue
            await self._commit("DELETE", entry.path, {"sha": entry.sha})

    async def rename(self, path: str, to: str) -> None:
        """Args:
            path (str): Mount-relative source.
            to (str): Mount-relative destination.
        """
        entry = (await self._tree())[path.strip("/")]
        data = await read_bytes(self._config, self._owner, self._repo,
                                entry.sha)
        await self.write(to, data)
        await self._commit("DELETE", entry.path, {"sha": entry.sha})


def _load(path: Path, name: str) -> ModuleType:
    """Import one integ server module by path.

    Args:
        path (Path): Module file.
        name (str): Name to register it under.
    """
    spec_obj = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec_obj)
    spec_obj.loader.exec_module(module)
    return module


def _pair(spec: dict, make: ResourceFactory) -> Pair:
    """Build the watched workspace and its external writer.

    Each side gets its own resource instance over the same backend, so
    nothing is shared but the bytes.

    Args:
        spec (dict): Parsed case file.
        make (ResourceFactory): Builds one fresh resource.
    """
    mount = spec["mount"]
    watched = Workspace({mount: make()}, mode=MountMode.WRITE)
    writer = Workspace({mount: make()}, mode=MountMode.WRITE)
    return watched, WorkspaceWriter(writer, mount)


async def build_disk(spec: dict) -> Pair | None:
    """Disk battery: a throwaway directory, no service at all.

    Args:
        spec (dict): Parsed case file.
    """
    root = tempfile.mkdtemp(prefix="mirage-watch-disk-")
    return _pair(spec, lambda: DiskResource(root))


async def build_ssh(spec: dict) -> Pair | None:
    """SSH battery against the in-process asyncssh SFTP server.

    A real server on a real socket, chrooted to a throwaway directory,
    so the per-directory SFTP descent is exercised end to end.

    Args:
        spec (dict): Parsed case file.
    """
    module = _load(SERVER_DIR / "ssh_server.py", "integ_watch_ssh")
    root = tempfile.mkdtemp(prefix="mirage-watch-ssh-")
    server = await module.start_server(root)
    port = server.get_port()
    return _pair(
        spec, lambda: SSHResource(
            SSHConfig(host="127.0.0.1",
                      port=port,
                      username="integ",
                      known_hosts=None,
                      root="/")))


async def build_dropbox(spec: dict) -> Pair | None:
    """Dropbox battery against the external dropbox fake.

    Exercises the recursive ``list_folder`` and its cursor pagination,
    and fingerprints on the fake's ``content_hash``.

    The server is TypeScript and shared across runs, so this needs
    ``DROPBOX_URL``. Each run takes its own ACCOUNT rather than resetting
    the server: the fake echoes the refresh token back as the access token,
    so a per-run token is a per-run tenant, and a reset would drop a
    concurrent run's data.

    Args:
        spec (dict): Parsed case file.
    """
    url = os.environ.get("DROPBOX_URL")
    if not url:
        return None
    url = url.rstrip("/")
    # Minted OUTSIDE the lambda: _pair calls it once per workspace, and a
    # token minted per call would put the writer and the watcher in two
    # different accounts, so every poll would see an empty tree.
    account = f"watch-{uuid.uuid4().hex[:8]}"
    return _pair(
        spec, lambda: DropboxResource(
            DropboxConfig(client_id="integ-client",
                          client_secret="integ-secret",
                          refresh_token=account,
                          endpoint=url,
                          root_path="/")))


async def build_s3(spec: dict) -> Pair | None:
    """S3 battery against whatever ``S3_ENDPOINT`` names (MinIO in CI).

    Each run takes its own key prefix so repeat runs cannot see each
    other's objects.

    Args:
        spec (dict): Parsed case file.
    """
    endpoint = os.environ.get("S3_ENDPOINT")
    bucket = os.environ.get("S3_BUCKET")
    if not endpoint or not bucket:
        return None
    prefix = f"watch-{uuid.uuid4().hex[:8]}/"
    return _pair(
        spec, lambda: S3Resource(
            S3Config(bucket=bucket,
                     region=os.environ.get("S3_REGION", "us-east-1"),
                     endpoint_url=endpoint,
                     aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
                     aws_secret_access_key=os.environ.get(
                         "AWS_SECRET_ACCESS_KEY"),
                     path_style=True,
                     key_prefix=prefix)))


async def build_gridfs(spec: dict) -> Pair | None:
    """GridFS battery against ``MONGODB_URI``.

    Each run takes its own database so repeat runs stay isolated.

    Args:
        spec (dict): Parsed case file.
    """
    uri = os.environ.get("MONGODB_URI")
    if not uri:
        return None
    database = f"watch_{uuid.uuid4().hex[:8]}"
    return _pair(
        spec, lambda: GridFSResource(
            GridFSConfig(uri=uri, database=database, bucket="fs")))


async def build_onedrive(spec: dict) -> Pair | None:
    """OneDrive battery against the external Graph fake.

    This is the ReaddirWalk path: Graph keys its tree by item id and has
    no whole-subtree listing, so the walk descends one
    ``/children`` request per directory against a fresh private index.

    Args:
        spec (dict): Parsed case file.
    """
    url = os.environ.get("ONEDRIVE_URL")
    if not url:
        return None
    url = url.rstrip("/")
    # Each run takes its own ACCOUNT (the access token is the account on this
    # fake). Minted OUTSIDE the lambda: _pair calls it once per workspace, and
    # minting per call would put the writer and the watcher in different
    # accounts, so every poll would see an empty tree.
    token = f"watch-{uuid.uuid4().hex[:8]}"
    return _pair(
        spec, lambda: OneDriveResource(
            OneDriveConfig(access_token=token, graph_base_url=url)))


async def build_box(spec: dict) -> Pair | None:
    """Box battery against the external box fake.

    The second ReaddirWalk target, and the one that proves the walk is
    not Graph-shaped: Box addresses folders by its own ids and answers a
    different listing endpoint.

    Args:
        spec (dict): Parsed case file.
    """
    url = os.environ.get("BOX_URL")
    if not url:
        return None
    url = url.rstrip("/")
    # Each run takes its own ACCOUNT (the access token is the account on this
    # fake) and one folder inside it. Minted OUTSIDE the lambda: _pair calls
    # it once per workspace, and minting per call would put the writer and the
    # watcher in different accounts.
    token = f"watch-{uuid.uuid4().hex[:8]}"
    async with aiohttp.ClientSession() as session:
        async with session.post(f"{url}/2.0/folders",
                                headers={"Authorization": f"Bearer {token}"},
                                json={
                                    "name": "watch",
                                    "parent": {
                                        "id": "0"
                                    }
                                }) as resp:
            resp.raise_for_status()
            folder_id = (await resp.json())["id"]
    return _pair(
        spec, lambda: BoxResource(
            BoxConfig(
                access_token=token, endpoint=url, root_folder_id=folder_id)))


async def build_hf(spec: dict) -> Pair | None:
    """Hugging Face battery against the external hub fake.

    Covers the shared opendal walk on a lister that omits per-entry
    metadata, which is the stat-backfill branch Nextcloud never reaches.
    opendal reports no last_modified for a Hub object at all, so only the
    ETag can move: a case that passes here passes on the ETag alone.

    The fake is TypeScript and shared across runs, so this needs ``HF_URL``
    and each run takes its own account -- the token is the account here.

    Args:
        spec (dict): Parsed case file.
    """
    url = os.environ.get("HF_URL")
    if not url:
        return None
    token = f"watch-hf-{uuid.uuid4().hex[:8]}"
    return _pair(
        spec, lambda: HfBucketsResource(
            HfBucketsConfig(
                bucket="integ/watch", token=token, endpoint=url.rstrip("/"))))


async def build_gdrive(spec: dict) -> Pair | None:
    """Google Drive battery against the external gws fake.

    The gws server is TypeScript and shared across runs, so this needs
    ``GWS_URL`` and each run resets it and takes its own folder.

    Args:
        spec (dict): Parsed case file.
    """
    url = os.environ.get("GWS_URL")
    if not url:
        return None
    url = url.rstrip("/")
    async with aiohttp.ClientSession() as session:
        async with session.post(f"{url}/reset", json={}) as resp:
            resp.raise_for_status()
        folder = f"watch-{uuid.uuid4().hex[:8]}"
        async with session.post(f"{url}/drive/v3/files",
                                json={
                                    "name":
                                    folder,
                                    "mimeType":
                                    "application/vnd.google-apps.folder",
                                }) as resp:
            resp.raise_for_status()
            folder_id = (await resp.json())["id"]
    return _pair(
        spec, lambda: GoogleDriveResource(
            GoogleDriveConfig(client_id="integ-client",
                              client_secret="integ-secret",
                              refresh_token="integ-refresh",
                              api_base=url,
                              folder_id=folder_id)))


async def build_github(spec: dict) -> Pair | None:
    """GitHub battery against the external github fake.

    The one target whose writer is not a workspace, because a git ref
    has no write ops to lend one. It is also the only backend whose
    fingerprint is a git blob sha, so a rewrite of identical bytes is
    correctly reported as nothing at all.

    The server is TypeScript now, so this needs ``GITHUB_URL``. It is
    seeded empty and the repository is created here, which is what the
    in-process fake did by reaching into its store directly.

    Args:
        spec (dict): Parsed case file.
    """
    url = os.environ.get("GITHUB_URL")
    if not url:
        return None
    url = url.rstrip("/")
    async with aiohttp.ClientSession() as session:
        async with session.post(
                f"{url}/orgs/{GITHUB_OWNER}/repos",
                headers={"Authorization": "Bearer integ-github-token"},
                json={"name": GITHUB_REPO}) as resp:
            # 422 is "it is already there", which a re-run makes ordinary.
            if resp.status not in (201, 422):
                resp.raise_for_status()
    config = GitHubConfig(token=SecretStr("integ-github-token"),
                          owner=GITHUB_OWNER,
                          repo=GITHUB_REPO,
                          ref=GITHUB_REF,
                          base_url=url)
    resource = GitHubResource(config)
    ws = Workspace({spec["mount"]: resource}, mode=MountMode.WRITE)
    return ws, GitHubWriter(config, GITHUB_OWNER, GITHUB_REPO, GITHUB_REF)


BUILDERS: dict[str, Callable[[dict], Awaitable[Pair | None]]] = {
    "disk": build_disk,
    "ssh": build_ssh,
    "dropbox": build_dropbox,
    "s3": build_s3,
    "gridfs": build_gridfs,
    "onedrive": build_onedrive,
    "box": build_box,
    "hf_buckets": build_hf,
    "gdrive": build_gdrive,
    "github": build_github,
}
