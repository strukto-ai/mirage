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

import importlib.util
import logging
import os
import shutil
import tempfile
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path
from types import ModuleType

import boto3
from moto.server import ThreadedMotoServer

from mirage import MountMode, Workspace
from mirage.accessor.onedrive import OneDriveConfig
from mirage.accessor.sharepoint import SharePointConfig
from mirage.core.sharepoint import _resolver as sharepoint_resolver
from mirage.resource.disk import DiskResource
from mirage.resource.nextcloud import NextcloudConfig, NextcloudResource
from mirage.resource.onedrive.onedrive import OneDriveResource
from mirage.resource.ram import RAMResource
from mirage.resource.redis import RedisResource
from mirage.resource.s3 import S3Config, S3Resource
from mirage.resource.sharepoint.sharepoint import SharePointResource
from mirage.resource.ssh import SSHConfig, SSHResource

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
S3_ENDPOINT = os.environ.get("S3_ENDPOINT")
S3_REGION = os.environ.get("S3_REGION", "us-east-1")
S3_ACCESS = os.environ.get("AWS_ACCESS_KEY_ID", "testing")
S3_SECRET = os.environ.get("AWS_SECRET_ACCESS_KEY", "testing")


async def _noop() -> None:
    return None


class S3Service:

    def __init__(self, run_id: str) -> None:
        self.stop: Callable[[], None] = lambda: None
        if S3_ENDPOINT:
            self.endpoint = S3_ENDPOINT
        else:
            logging.getLogger("werkzeug").setLevel(logging.ERROR)
            server = ThreadedMotoServer(ip_address="127.0.0.1",
                                        port=0,
                                        verbose=False)
            server.start()
            host, port = server.get_host_and_port()
            self.endpoint = f"http://{host}:{port}"
            self.stop = server.stop
        self.client = boto3.client("s3",
                                   endpoint_url=self.endpoint,
                                   aws_access_key_id=S3_ACCESS,
                                   aws_secret_access_key=S3_SECRET,
                                   region_name=S3_REGION)
        self.prefix = f"mirage-integ-{run_id}"
        self.buckets: set[str] = set()

    def bucket_for(self, mount: dict) -> str:
        name = f"{self.prefix}-{mount['bucket']}"
        if name not in self.buckets:
            self.client.create_bucket(Bucket=name)
            self.buckets.add(name)
        return name

    def resource(self, mount: dict) -> S3Resource:
        return S3Resource(
            S3Config(bucket=self.bucket_for(mount),
                     region=S3_REGION,
                     endpoint_url=self.endpoint,
                     aws_access_key_id=S3_ACCESS,
                     aws_secret_access_key=S3_SECRET,
                     path_style=True,
                     key_prefix=mount.get("prefix")))

    async def teardown(self) -> None:
        for bucket in self.buckets:
            paginator = self.client.get_paginator("list_objects_v2")
            for page in paginator.paginate(Bucket=bucket):
                for obj in page.get("Contents", []):
                    self.client.delete_object(Bucket=bucket, Key=obj["Key"])
            self.client.delete_bucket(Bucket=bucket)
        self.stop()


def _load_module(path: Path) -> ModuleType:
    # Modules at the integ root never go on sys.path (integ/redis.py would
    # shadow the redis package); load them by file.
    spec = importlib.util.spec_from_file_location(path.stem, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_onedrive_server() -> ModuleType:
    return _load_module(
        Path(__file__).resolve().parents[2] / "onedrive_server.py")


def _load_ssh_server() -> ModuleType:
    return _load_module(
        Path(__file__).resolve().parents[1] / "tools" / "ssh_server.py")


async def _admin_exec(ws: Workspace, command: str) -> None:
    result = await ws.execute(command)
    if result.exit_code:
        raise RuntimeError(f"admin command failed: {command}: "
                           f"{await result.stderr_str()}")


class SSHService:

    def __init__(self, host: str, port: int, server, root_dir: str | None,
                 admin: SSHResource, admin_ws: Workspace, base: str) -> None:
        self.host = host
        self.port = port
        self.server = server
        self.root_dir = root_dir
        self.admin = admin
        self.admin_ws = admin_ws
        self.base = base
        self.resources: list[SSHResource] = []

    @classmethod
    async def create(cls, run_id: str, target: dict) -> "SSHService":
        host = os.environ.get("SSH_HOST")
        server = None
        root_dir = None
        if host:
            port = int(os.environ.get("SSH_PORT", "22"))
        else:
            module = _load_ssh_server()
            root_dir = tempfile.mkdtemp(prefix="mirage-integ-ssh-")
            server = await module.start_server(root_dir)
            host = "127.0.0.1"
            port = server.get_port()
        base = f"mirage-integ-{run_id}"
        admin = SSHResource(SSHConfig(host=host, port=port, username="integ"))
        admin_ws = Workspace({"/admin": admin}, mode=MountMode.WRITE)
        paths = " ".join(f"/admin/{base}/{m['root']}"
                         for m in target["mounts"])
        await _admin_exec(admin_ws, f"mkdir -p {paths}")
        return cls(host, port, server, root_dir, admin, admin_ws, base)

    def resource(self, mount: dict) -> SSHResource:
        res = SSHResource(
            SSHConfig(host=self.host,
                      port=self.port,
                      username="integ",
                      root=f"/{self.base}/{mount['root']}"))
        self.resources.append(res)
        return res

    async def teardown(self) -> None:
        await _admin_exec(self.admin_ws, f"rm -rf /admin/{self.base}")
        # Workspace.close() does not close resource accessors; an in-process
        # server's wait_closed() blocks until every client connection is gone.
        for res in self.resources:
            await res.accessor.close()
        await self.admin_ws.close()
        await self.admin.accessor.close()
        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()
        if self.root_dir is not None:
            shutil.rmtree(self.root_dir, ignore_errors=True)


class NextcloudService:

    def __init__(self, url: str, username: str | None, password: str | None,
                 admin_ws: Workspace, base: str) -> None:
        self.url = url
        self.username = username
        self.password = password
        self.admin_ws = admin_ws
        self.base = base

    @classmethod
    async def create(cls, run_id: str, target: dict) -> "NextcloudService":
        url = os.environ["NEXTCLOUD_URL"]
        username = os.environ.get("NEXTCLOUD_USERNAME", "admin")
        password = os.environ.get("NEXTCLOUD_PASSWORD", "admin123")
        base = f"mirage-integ-{run_id}"
        admin = NextcloudResource(
            NextcloudConfig(url=url, username=username, password=password))
        admin_ws = Workspace({"/admin": admin}, mode=MountMode.WRITE)
        paths = " ".join(f"/admin/{base}/{m['root']}"
                         for m in target["mounts"])
        await _admin_exec(admin_ws, f"mkdir -p {paths}")
        return cls(url, username, password, admin_ws, base)

    def resource(self, mount: dict) -> NextcloudResource:
        url = f"{self.url.rstrip('/')}/{self.base}/{mount['root']}/"
        return NextcloudResource(
            NextcloudConfig(url=url,
                            username=self.username,
                            password=self.password))

    async def teardown(self) -> None:
        await _admin_exec(self.admin_ws, f"rm -rf /admin/{self.base}")
        await self.admin_ws.close()


class OneDriveService:

    def __init__(self, runner) -> None:
        self.runner = runner

    @classmethod
    async def create(cls) -> "OneDriveService":
        module = _load_onedrive_server()
        _state, _server, runner = await module.start_fake_graph()
        return cls(runner)

    def resource(self, mount: dict) -> OneDriveResource:
        return OneDriveResource(
            OneDriveConfig(access_token="integ-token",
                           key_prefix=mount.get("prefix")))

    async def teardown(self) -> None:
        await self.runner.cleanup()


def _clear_sharepoint_caches() -> None:
    # The resolver's site/drive id caches are module globals; a fresh
    # fake tenant per run must not see ids from the previous one.
    sharepoint_resolver._site_cache.clear()
    sharepoint_resolver._drive_cache.clear()


class SharePointService:

    def __init__(self, server, runner) -> None:
        self.server = server
        self.runner = runner

    @classmethod
    async def create(cls) -> "SharePointService":
        module = _load_onedrive_server()
        _state, server, runner = await module.start_fake_graph()
        _clear_sharepoint_caches()
        return cls(server, runner)

    def resource(self, mount: dict) -> SharePointResource:
        self.server.add_drive(mount["drive"])
        return SharePointResource(
            SharePointConfig(access_token="integ-token",
                             site="Main",
                             drive=mount["drive"]))

    async def teardown(self) -> None:
        _clear_sharepoint_caches()
        await self.runner.cleanup()


Service = (S3Service | OneDriveService | SharePointService | SSHService
           | NextcloudService)


def build_ram(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    return RAMResource(), _noop


def build_disk(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    root = tempfile.mkdtemp(prefix=f"mirage-integ-disk-{run_id}-")

    async def cleanup() -> None:
        shutil.rmtree(root, ignore_errors=True)

    return DiskResource(root=root), cleanup


def build_redis(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    safe_path = mount["path"].strip("/").replace("/", "-") or "root"
    prefix = f"mirage-integ-{run_id}-{safe_path}/"
    return RedisResource(url=REDIS_URL, key_prefix=prefix), _noop


def build_s3(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, S3Service)
    return service.resource(mount), _noop


def build_onedrive(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, OneDriveService)
    return service.resource(mount), _noop


def build_sharepoint(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, SharePointService)
    return service.resource(mount), _noop


def build_ssh(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, SSHService)
    return service.resource(mount), _noop


def build_nextcloud(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, NextcloudService)
    return service.resource(mount), _noop


BUILDERS = {
    "ram": build_ram,
    "disk": build_disk,
    "redis": build_redis,
    "s3": build_s3,
    "onedrive": build_onedrive,
    "sharepoint": build_sharepoint,
    "ssh": build_ssh,
    "nextcloud": build_nextcloud,
}


async def open_target(
        target: dict) -> tuple[Workspace, Callable[[], Awaitable[None]]]:
    run_id = uuid.uuid4().hex[:8]
    service: Service | None = None
    if target.get("service") == "s3":
        service = S3Service(run_id)
    elif target.get("service") == "onedrive":
        service = await OneDriveService.create()
    elif target.get("service") == "sharepoint":
        service = await SharePointService.create()
    elif target.get("service") == "ssh":
        service = await SSHService.create(run_id, target)
    elif target.get("service") == "nextcloud":
        service = await NextcloudService.create(run_id, target)
    mounts: dict[str, object] = {}
    cleanups: list[Callable[[], Awaitable[None]]] = []
    for mount in target["mounts"]:
        builder = BUILDERS[mount["resource"]]
        resource, cleanup = builder(mount, run_id, service)
        mounts[mount["path"]] = resource
        cleanups.append(cleanup)
    ws = Workspace(mounts, mode=MountMode.WRITE)

    async def cleanup_all() -> None:
        await ws.close()
        for cleanup in cleanups:
            await cleanup()
        if service is not None:
            await service.teardown()

    return ws, cleanup_all
