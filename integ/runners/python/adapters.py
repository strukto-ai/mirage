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
import os
import shutil
import tempfile
import uuid
from collections.abc import Awaitable, Callable

import boto3
from moto.server import ThreadedMotoServer

from mirage import MountMode, Workspace
from mirage.resource.disk import DiskResource
from mirage.resource.ram import RAMResource
from mirage.resource.redis import RedisResource
from mirage.resource.s3 import S3Config, S3Resource

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

    def teardown(self) -> None:
        for bucket in self.buckets:
            paginator = self.client.get_paginator("list_objects_v2")
            for page in paginator.paginate(Bucket=bucket):
                for obj in page.get("Contents", []):
                    self.client.delete_object(Bucket=bucket, Key=obj["Key"])
            self.client.delete_bucket(Bucket=bucket)
        self.stop()


def build_ram(
        mount: dict, run_id: str,
        s3: S3Service | None) -> tuple[object, Callable[[], Awaitable[None]]]:
    return RAMResource(), _noop


def build_disk(
        mount: dict, run_id: str,
        s3: S3Service | None) -> tuple[object, Callable[[], Awaitable[None]]]:
    root = tempfile.mkdtemp(prefix=f"mirage-integ-disk-{run_id}-")

    async def cleanup() -> None:
        shutil.rmtree(root, ignore_errors=True)

    return DiskResource(root=root), cleanup


def build_redis(
        mount: dict, run_id: str,
        s3: S3Service | None) -> tuple[object, Callable[[], Awaitable[None]]]:
    safe_path = mount["path"].strip("/").replace("/", "-") or "root"
    prefix = f"mirage-integ-{run_id}-{safe_path}/"
    return RedisResource(url=REDIS_URL, key_prefix=prefix), _noop


def build_s3(
        mount: dict, run_id: str,
        s3: S3Service | None) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert s3 is not None
    return s3.resource(mount), _noop


BUILDERS = {
    "ram": build_ram,
    "disk": build_disk,
    "redis": build_redis,
    "s3": build_s3,
}


async def open_target(
        target: dict) -> tuple[Workspace, Callable[[], Awaitable[None]]]:
    run_id = uuid.uuid4().hex[:8]
    s3 = S3Service(run_id) if target.get("service") == "s3" else None
    mounts: dict[str, object] = {}
    cleanups: list[Callable[[], Awaitable[None]]] = []
    for mount in target["mounts"]:
        builder = BUILDERS[mount["resource"]]
        resource, cleanup = builder(mount, run_id, s3)
        mounts[mount["path"]] = resource
        cleanups.append(cleanup)
    ws = Workspace(mounts, mode=MountMode.WRITE)

    async def cleanup_all() -> None:
        await ws.close()
        for cleanup in cleanups:
            await cleanup()
        if s3 is not None:
            s3.teardown()

    return ws, cleanup_all
