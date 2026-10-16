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

import os
import tempfile
import uuid
from typing import Any, Awaitable, Callable

import aiohttp

from mirage import MountMode, Workspace
from mirage.vfs.box import BoxConfig, BoxVFS
from mirage.vfs.disk import DiskVFS
from mirage.vfs.dropbox import DropboxConfig, DropboxVFS
from mirage.vfs.gdrive import GoogleDriveVFS
from mirage.vfs.gdrive.config import GoogleDriveConfig
from mirage.vfs.onedrive import OneDriveConfig, OneDriveVFS

# The gws fake's credential: a bearer as it is, and the one refresh token its
# /token exchanges.
GWS_TOKEN = "gws-integ-token"

Pair = tuple[Workspace, "WorkspaceWriter"]
VFSFactory = Callable[[], Any]


class WorkspaceWriter:
    """External writer backed by a second workspace over one backend.

    The batteries need a mutation the subscribed workspace did not make, so
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
        ws (Workspace): Writer workspace, distinct from the subscribed
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
        await self._ws.shell(f"mkdir -p {self._virtual(path)}")

    async def write(self, path: str, data: bytes) -> None:
        """Args:
        path (str): Mount-relative file path.
        data (bytes): Content to store.
        """
        key = path.strip("/")
        parent = key.rsplit("/", 1)[0]
        if parent != key:
            await self.create_dir(parent)
        await self._ws.vfs.write(self._virtual(key), data)

    async def delete(self, path: str) -> None:
        """Args:
        path (str): Mount-relative path; a directory goes with its
            subtree, matching opendal's delete.
        """
        await self._ws.shell(f"rm -rf {self._virtual(path)}")

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
        await self._ws.vfs.rename(self._virtual(path), self._virtual(to))

    async def close(self) -> None:
        await self._ws.close()


def _pair(spec: dict, make: VFSFactory) -> Pair:
    """Build the subscribed workspace and its external writer.

    Each side gets its own VFS instance over the same backend, so
    nothing is shared but the bytes.

    Args:
        spec (dict): Parsed case file.
        make (VFSFactory): Builds one fresh VFS.
    """
    mount = spec["mount"]
    subscribed = Workspace({mount: make()}, mode=MountMode.WRITE)
    writer = Workspace({mount: make()}, mode=MountMode.WRITE)
    return subscribed, WorkspaceWriter(writer, mount)


async def build_disk(spec: dict) -> Pair | None:
    """Disk battery: a throwaway directory, no service at all.

    Args:
        spec (dict): Parsed case file.
    """
    root = tempfile.mkdtemp(prefix="mirage-events-disk-")
    return _pair(spec, lambda: DiskVFS(root))


async def build_dropbox(spec: dict) -> Pair | None:
    """Dropbox battery against the external dropbox fake.

    Each ping is one ``list_folder/continue`` from the cursor
    ``get_latest_cursor`` handed out at the baseline.

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
    # token minted per call would put the writer and the subscriber in two
    # different accounts, so every poll would see an empty tree.
    account = f"events-{uuid.uuid4().hex[:8]}"
    return _pair(
        spec,
        lambda: DropboxVFS(
            DropboxConfig(
                client_id="integ-client",
                client_secret="integ-secret",
                refresh_token=account,
                endpoint=url,
                root_path="/",
            )
        ),
    )


async def build_onedrive(spec: dict) -> Pair | None:
    """OneDrive battery against the external Graph fake.

    Each ping is one read of the drive's ``/delta`` feed, placed by the
    parents its items name.

    Args:
        spec (dict): Parsed case file.
    """
    url = os.environ.get("ONEDRIVE_URL")
    if not url:
        return None
    url = url.rstrip("/")
    # Each run takes its own ACCOUNT (the access token is the account on this
    # fake). Minted OUTSIDE the lambda: _pair calls it once per workspace, and
    # minting per call would put the writer and the subscriber in different
    # accounts, so every poll would see an empty tree.
    token = f"events-{uuid.uuid4().hex[:8]}"
    return _pair(
        spec,
        lambda: OneDriveVFS(
            OneDriveConfig(access_token=token, graph_base_url=url)
        ),
    )


async def build_box(spec: dict) -> Pair | None:
    """Box battery against the external box fake.

    Each ping is one read of the fake's ``/events`` stream from the
    position the last read left, so a case passes only if the event it
    caused is placed on the right path.

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
    # subscriber in different accounts.
    token = f"events-{uuid.uuid4().hex[:8]}"
    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{url}/2.0/folders",
            headers={"Authorization": f"Bearer {token}"},
            json={"name": "events", "parent": {"id": "0"}},
        ) as resp:
            resp.raise_for_status()
            folder_id = (await resp.json())["id"]
    return _pair(
        spec,
        lambda: BoxVFS(
            BoxConfig(
                access_token=token, endpoint=url, root_folder_id=folder_id
            )
        ),
    )


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
    headers = {"Authorization": f"Bearer {GWS_TOKEN}"}
    async with aiohttp.ClientSession(headers=headers) as session:
        async with session.post(f"{url}/reset", json={}) as resp:
            resp.raise_for_status()
        folder = f"events-{uuid.uuid4().hex[:8]}"
        async with session.post(
            f"{url}/drive/v3/files",
            json={
                "name": folder,
                "mimeType": "application/vnd.google-apps.folder",
            },
        ) as resp:
            resp.raise_for_status()
            folder_id = (await resp.json())["id"]
    return _pair(
        spec,
        lambda: GoogleDriveVFS(
            GoogleDriveConfig(
                client_id="integ-client",
                client_secret="integ-secret",
                refresh_token=GWS_TOKEN,
                api_base=url,
                folder_id=folder_id,
            )
        ),
    )


BUILDERS: dict[str, Callable[[dict], Awaitable[Pair | None]]] = {
    "disk": build_disk,
    "dropbox": build_dropbox,
    "onedrive": build_onedrive,
    "box": build_box,
    "gdrive": build_gdrive,
}
