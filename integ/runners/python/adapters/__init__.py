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

import asyncio
import base64
import functools
import gzip
import importlib.util
import inspect
import json
import logging
import os
import shutil
import tempfile
import uuid
from collections.abc import Awaitable, Callable
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from types import ModuleType

import aiohttp
import asyncpg
import boto3
import chromadb
import lancedb
from databricks_client import HttpFilesClient
from moto.server import ThreadedMotoServer
from pymongo import AsyncMongoClient
from qdrant_client import AsyncQdrantClient, models

from mirage import MountMode, Workspace
from mirage.accessor.onedrive import OneDriveConfig
from mirage.accessor.sharepoint import SharePointConfig
from mirage.commands.cli.specs import cli_spec_for
from mirage.commands.cli.types import CLISpec
from mirage.core.databricks_volume.path import configured_root
from mirage.core.discord.config import DiscordConfig
from mirage.core.email.config import EmailConfig
from mirage.resource.aliyun import AliyunConfig, AliyunResource
from mirage.resource.backblaze import BackblazeConfig, BackblazeResource
from mirage.resource.box import BoxConfig, BoxResource
from mirage.resource.ceph import CephConfig, CephResource
from mirage.resource.chroma import ChromaConfig, ChromaResource
from mirage.resource.databricks_volume import (DatabricksVolumeConfig,
                                               DatabricksVolumeResource)
from mirage.resource.dify import DifyConfig, DifyResource
from mirage.resource.digitalocean import (DigitalOceanConfig,
                                          DigitalOceanResource)
from mirage.resource.discord.discord import DiscordResource
from mirage.resource.disk import DiskResource
from mirage.resource.dropbox import DropboxConfig, DropboxResource
from mirage.resource.email.email import EmailResource
from mirage.resource.gcal.config import GCalConfig
from mirage.resource.gcal.gcal import GCalResource
from mirage.resource.gcs import GCSConfig, GCSResource
from mirage.resource.gdocs.config import GDocsConfig
from mirage.resource.gdocs.gdocs import GDocsResource
from mirage.resource.gdrive.config import GoogleDriveConfig
from mirage.resource.gdrive.gdrive import GoogleDriveResource
from mirage.resource.github import GitHubConfig, GitHubResource
from mirage.resource.gmail.config import GmailConfig
from mirage.resource.gmail.gmail import GmailResource
from mirage.resource.gridfs import GridFSConfig, GridFSResource
from mirage.resource.gsheets.config import GSheetsConfig
from mirage.resource.gsheets.gsheets import GSheetsResource
from mirage.resource.gslides.config import GSlidesConfig
from mirage.resource.gslides.gslides import GSlidesResource
from mirage.resource.hf_buckets import HfBucketsConfig, HfBucketsResource
from mirage.resource.hf_datasets import HfDatasetsConfig, HfDatasetsResource
from mirage.resource.hf_models import HfModelsConfig, HfModelsResource
from mirage.resource.hf_spaces import HfSpacesConfig, HfSpacesResource
from mirage.resource.jaeger import JaegerConfig, JaegerResource
from mirage.resource.lancedb import LanceDBConfig, LanceDBResource
from mirage.resource.langfuse import LangfuseConfig, LangfuseResource
from mirage.resource.linear import LinearConfig, LinearResource
from mirage.resource.mem0 import Mem0Config, Mem0Resource
from mirage.resource.minio import MinIOConfig, MinIOResource
from mirage.resource.mongodb import MongoDBConfig, MongoDBResource
from mirage.resource.nextcloud import NextcloudConfig, NextcloudResource
from mirage.resource.notion import NotionConfig, NotionResource
from mirage.resource.oci import OCIConfig, OCIResource
from mirage.resource.onedrive.onedrive import OneDriveResource
from mirage.resource.postgres import PostgresConfig, PostgresResource
from mirage.resource.qdrant import QdrantConfig, QdrantResource
from mirage.resource.qingstor import QingStorConfig, QingStorResource
from mirage.resource.r2 import R2Config, R2Resource
from mirage.resource.ram import RAMResource
from mirage.resource.redis import RedisResource
from mirage.resource.s3 import S3Config, S3Resource
from mirage.resource.scaleway import ScalewayConfig, ScalewayResource
from mirage.resource.seaweedfs import SeaweedFSConfig, SeaweedFSResource
from mirage.resource.sharepoint.sharepoint import SharePointResource
from mirage.resource.slack import SlackConfig, SlackResource
from mirage.resource.ssh import SSHConfig, SSHResource
from mirage.resource.supabase import SupabaseConfig, SupabaseResource
from mirage.resource.tencent import TencentConfig, TencentResource
from mirage.resource.trello import TrelloConfig, TrelloResource
from mirage.resource.wasabi import WasabiConfig, WasabiResource
from mirage.runtime.types import ScriptSource
from mirage.shell.console import JobConsole
from mirage.shell.console.redis import RedisConsoleStore
from mirage.shell.job_table import ConsoleFactory
from mirage.types import ConsistencyPolicy

from .secrets import build_secrets_env

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
EMAIL_IMAP_PORT = int(os.environ.get("EMAIL_IMAP_PORT", "3143"))
EMAIL_SMTP_PORT = int(os.environ.get("EMAIL_SMTP_PORT", "3025"))
EMAIL_USERNAME = "integ@example.com"
# The repository the `gh` install defaults to, standing in for the current
# git remote real gh reads. Seeded by the fake alongside the mounted one.
GH_CLI_REPO = "integ/repo-cli"
# Two more accounts. The mount keeps the primary; the renamed CLI installs h1
# and h2 hold these two, so the mount and the CLIs never share an account and a
# line's behavior proves which config it ran under.
EMAIL_USERNAME_ALPHA = "alpha@example.com"
EMAIL_USERNAME_BETA = "beta@example.com"
# The tenants the fake seeds, which are the local parts of the three addresses
# above. One served domain, so the local part is the whole identity.
EMAIL_ACCOUNTS = ("integ", "alpha", "beta")
# The directory the shared mail manifest lives in, and the one the fake expands
# from. A target names `email/v1`; the fake takes fixture NAMES, never paths,
# so the prefix is checked off here rather than passed through.
EMAIL_MANIFEST_DIR = "email"
# Doubles as the workspace id on the fake notion server.
NOTION_TOKEN = "integ-test"
MONGODB_URI = os.environ.get("MONGODB_URI", "mongodb://localhost:27017")
S3_ENDPOINT = os.environ.get("S3_ENDPOINT")
S3_REGION = os.environ.get("S3_REGION", "us-east-1")
S3_ACCESS = os.environ.get("AWS_ACCESS_KEY_ID", "testing")
S3_SECRET = os.environ.get("AWS_SECRET_ACCESS_KEY", "testing")


def object_storage_resource(name: str, bucket: str, endpoint: str,
                            key_prefix: str | None) -> S3Resource:
    common = {
        "bucket": bucket,
        "region": S3_REGION,
        "endpoint_url": endpoint,
        "access_key_id": S3_ACCESS,
        "secret_access_key": S3_SECRET,
        "key_prefix": key_prefix,
    }
    if name == "s3":
        return S3Resource(
            S3Config(bucket=bucket,
                     region=S3_REGION,
                     endpoint_url=endpoint,
                     aws_access_key_id=S3_ACCESS,
                     aws_secret_access_key=S3_SECRET,
                     path_style=True,
                     key_prefix=key_prefix))
    if name == "aliyun":
        return AliyunResource(AliyunConfig(**common, path_style=True))
    if name == "backblaze":
        return BackblazeResource(BackblazeConfig(**common, path_style=True))
    if name == "ceph":
        return CephResource(CephConfig(**common))
    if name == "digitalocean":
        return DigitalOceanResource(
            DigitalOceanConfig(**common, path_style=True))
    if name == "gcs":
        return GCSResource(GCSConfig(**common, path_style=True))
    if name == "minio":
        return MinIOResource(MinIOConfig(**common))
    if name == "oci":
        return OCIResource(OCIConfig(**common, namespace="integ"))
    if name == "qingstor":
        return QingStorResource(QingStorConfig(**common, path_style=True))
    if name == "r2":
        return R2Resource(R2Config(**common, path_style=True))
    if name == "scaleway":
        return ScalewayResource(ScalewayConfig(**common, path_style=True))
    if name == "seaweedfs":
        return SeaweedFSResource(SeaweedFSConfig(**common))
    if name == "supabase":
        return SupabaseResource(SupabaseConfig(**common))
    if name == "tencent":
        return TencentResource(TencentConfig(**common, path_style=True))
    if name == "wasabi":
        return WasabiResource(WasabiConfig(**common, path_style=True))
    raise ValueError(f"unknown object storage resource: {name}")


async def _noop() -> None:
    return None


def manifest_mime(entry: dict) -> MIMEText | MIMEMultipart:
    """Build the constrained RFC822 shape shared mail manifests describe.

    Args:
        entry (dict): manifest row with from/to/cc/subject/date/body and
            optional attachments.

    Returns:
        MIMEText | MIMEMultipart: single text part, or multipart/mixed with
        text attachments.
    """
    if entry.get("attachments"):
        mime: MIMEText | MIMEMultipart = MIMEMultipart("mixed")
        mime.attach(MIMEText(entry["body"], "plain", "utf-8"))
        for att in entry["attachments"]:
            part = MIMEText(att["content"], "plain", "utf-8")
            part.add_header("Content-Disposition",
                            "attachment",
                            filename=att["filename"])
            mime.attach(part)
    else:
        mime = MIMEText(entry["body"], "plain", "utf-8")
    mime["From"] = entry["from"]
    mime["To"] = entry["to"]
    if entry.get("cc"):
        mime["Cc"] = ", ".join(entry["cc"])
    mime["Subject"] = entry["subject"]
    mime["Date"] = entry["date"]
    return mime


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
        return object_storage_resource(mount["resource"],
                                       self.bucket_for(mount), self.endpoint,
                                       mount.get("prefix"))

    async def teardown(self) -> None:
        for bucket in self.buckets:
            paginator = self.client.get_paginator("list_objects_v2")
            for page in paginator.paginate(Bucket=bucket):
                for obj in page.get("Contents", []):
                    self.client.delete_object(Bucket=bucket, Key=obj["Key"])
            self.client.delete_bucket(Bucket=bucket)
        self.stop()


class GridFSService:

    def __init__(self, run_id: str) -> None:
        self.uri = MONGODB_URI
        self.database = f"mirage_integ_{run_id}"

    def resource(self, mount: dict) -> GridFSResource:
        return GridFSResource(
            GridFSConfig(uri=self.uri,
                         database=self.database,
                         bucket=mount["bucket"],
                         key_prefix=mount.get("prefix")))

    async def teardown(self) -> None:
        client: AsyncMongoClient = AsyncMongoClient(self.uri)
        try:
            await client.drop_database(self.database)
        finally:
            await client.close()


class DatabricksVolumeService:
    """Points databricks mounts at the kit fake for volume files.

    The fake is a TypeScript kit service now, so the adapter spawns it the way
    the mem0 one does instead of importing an aiohttp app. The volume root is
    created over HTTP rather than by reaching into the server's own store,
    which is the same PUT the TypeScript host already sends and the only way
    to say it once the fake is another process.

    Each run takes its own bearer token, which the fake reads as its tenant,
    so two runs sharing one server cannot see each other's writes.

    Args:
        run_id (str): this run's id, which scopes the token and the volumes.
        base (str): the fake's origin.
        process (asyncio.subprocess.Process): the running fake.
    """

    def __init__(self, run_id: str, base: str,
                 process: asyncio.subprocess.Process) -> None:
        self.run_id = run_id
        self.base = base
        self.process = process
        self.token = f"integ-{run_id}"

    @classmethod
    async def create(cls, run_id: str) -> "DatabricksVolumeService":
        base, process = await start_kit_fake("databricks")
        return cls(run_id, base, process)

    def resource(self, mount: dict) -> DatabricksVolumeResource:
        volume = f"mirage-integ-{self.run_id}-{mount['volume']}"
        config = DatabricksVolumeConfig(catalog="main",
                                        schema="default",
                                        volume=volume,
                                        root_path=mount.get("prefix") or "/")
        client = HttpFilesClient(self.base, self.token)
        client.files.create_directory(configured_root(config))
        return DatabricksVolumeResource(config, client=client)

    async def teardown(self) -> None:
        await stop_kit_fake(self.process)


async def start_kit_fake(
        service: str) -> tuple[str, asyncio.subprocess.Process]:
    """Start integ/server/<service>/main.ts and read the endpoint it announces.

    The adapter owns the process rather than reading a URL from the
    environment, which is what keeps a single-target run free of CI setup.
    Every kit fake announces ``<SERVICE>_URL=<origin>`` on its first stdout
    line, so one reader serves all of them instead of one per service.

    Args:
        service (str): directory under integ/server/ holding main.ts.

    Returns:
        tuple[str, asyncio.subprocess.Process]: the endpoint and the process.
    """
    integ = Path(__file__).resolve().parents[3]
    process = await asyncio.create_subprocess_exec(
        str(integ / "node_modules" / ".bin" / "tsx"),
        str(integ / "server" / service / "main.ts"),
        "--port",
        "0",
        cwd=str(integ),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    assert process.stdout is not None
    token = f"{service.upper().replace('-', '_')}_URL"
    line = (await process.stdout.readline()).decode().strip()
    endpoint = line.partition("=")[2] if line.startswith(f"{token}=") else ""
    if not endpoint:
        assert process.stderr is not None
        detail = (await process.stderr.read()).decode().strip()
        raise RuntimeError(f"{service} fake failed to start: {line}{detail}")
    return endpoint, process


async def stop_kit_fake(process: asyncio.subprocess.Process) -> None:
    """Terminate a fake started by :func:`start_kit_fake`.

    Args:
        process (asyncio.subprocess.Process): the running fake.
    """
    if process.returncode is None:
        process.terminate()
        await process.wait()


def _load_module(path: Path) -> ModuleType:
    # Modules at the integ root never go on sys.path (integ/redis.py would
    # shadow the redis package); load them by file.
    spec = importlib.util.spec_from_file_location(path.stem, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_ssh_server() -> ModuleType:
    return _load_module(
        Path(__file__).resolve().parents[3] / "server" / "ssh_server.py")


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
        # A server-side symlink in the /links mount: mirage's shell ln -s
        # only makes namespace links, so the battery needs one created over
        # SFTP to pin that ssh stat follows links (target size, not
        # link-text length). Dangling until the fixture seeds poem.txt.
        sftp = await admin.accessor.sftp()
        for m in target["mounts"]:
            if m["root"] == "links":
                await sftp.symlink("../data/poem.txt",
                                   f"/{base}/{m['root']}/poem_link.txt")
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


FOLDER_MIME = "application/vnd.google-apps.folder"


class GwsService:
    """Points gdrive mounts at the fake Google Workspace server.

    The server is external (integ/server/gws/) and shared across runs;
    /reset gives each run a clean, deterministic state. Each mount is scoped
    to a per-mount folder via GoogleConfig.folder_id, the s3 key_prefix
    analog, so the three mounts never see each other.
    """

    def __init__(self, url: str, folder_ids: dict[str, str],
                 cli_scope: str | None) -> None:
        self.url = url
        self.folder_ids = folder_ids
        # A target may scope the gws install to one mount's folder, the
        # configuration where the CLI and the mount are the same folder.
        self.cli_scope = cli_scope

    @classmethod
    async def create(cls, run_id: str, target: dict) -> "GwsService":
        # Every call below goes to this run's own world. gws keeps per-run
        # state already; what it lacked was a way for a mount to ask for one,
        # since a mount hands its base URL to a client and never sees the
        # request. Scoping the base once covers the reset, the drives and
        # folders, the seeds and every mount.
        url = f'{os.environ["GWS_URL"].rstrip("/")}/_run/{run_id}'
        folder_ids: dict[str, str] = {}
        drive_ids: dict[str, str] = {}
        # Native mounts (gdocs/gsheets/gslides) render the modified date
        # into filenames, so those targets pin the server clock.
        epoch = target.get("epoch")
        reset_body: dict = {"epoch": epoch} if epoch else {}
        # Secondary calendars and seeded form responses are declared to
        # /reset rather than inserted: a calendar's accessRole and a form
        # response are both states no API call can produce. They ride
        # `extras`, which is the kit's channel for exactly this and is what
        # the gws fake reads now that it seeds through the kit; the base
        # world (system labels, the primary calendar) is fixture rows.
        extras: dict = {}
        calendar = cls._manifest(target.get("calendar"))
        if calendar and calendar.get("calendars"):
            extras["calendars"] = calendar["calendars"]
        forms = cls._manifest(target.get("forms"))
        if forms:
            extras["forms"] = forms
        if extras:
            reset_body["extras"] = extras
        async with aiohttp.ClientSession() as session:
            async with session.post(f"{url}/reset", json=reset_body) as resp:
                resp.raise_for_status()
            for mount in target["mounts"]:
                if "root" not in mount:
                    continue
                # A mount may live inside a Shared Drive: the drive is
                # created once per name and its id is the walk's start.
                drive = mount.get("drive")
                if drive and drive not in drive_ids:
                    async with session.post(f"{url}/drive/v3/drives",
                                            json={"name": drive}) as resp:
                        resp.raise_for_status()
                        drive_ids[drive] = (await resp.json())["id"]
                parent = drive_ids[drive] if drive else "root"
                for segment in str(mount["root"]).split("/"):
                    parent = await cls._folder(session, url, segment, parent)
                folder_ids[mount["path"]] = parent
            apps = cls._manifest(target.get("apps"))
            if apps:
                await cls._seed_apps(session, url, apps)
            mail = cls._manifest(target.get("mail"))
            if mail:
                await cls._seed_mail(session, url, mail)
            if calendar:
                await cls._seed_calendar(session, url, calendar["events"])
        return cls(url, folder_ids, target.get("cli_scope"))

    @staticmethod
    def _manifest(name: str | None) -> list | dict | None:
        """Read a fixture manifest by its targets.json name.

        Args:
            name (str | None): the fixture path, e.g. ``calendar/v1``.

        Returns:
            list | dict | None: the parsed manifest, or None when unnamed.
        """
        if not name:
            return None
        path = Path(
            __file__).resolve().parents[3] / "fixtures" / f"{name}.json"
        return json.loads(path.read_text())

    @staticmethod
    async def _seed_apps(session: aiohttp.ClientSession, url: str,
                         entries: list[dict]) -> None:
        # Native files are API objects, not byte blobs, so they seed through
        # the same editor APIs the backends speak instead of fixture uploads.
        for entry in entries:
            kind = entry["kind"]
            if kind == "doc":
                async with session.post(f"{url}/v1/documents",
                                        json={"title": entry["name"]}) as resp:
                    resp.raise_for_status()
                    doc_id = (await resp.json())["documentId"]
                requests = [{
                    "insertText": {
                        "location": {
                            "index": 1
                        },
                        "text": entry["text"],
                    }
                }]
                async with session.post(
                        f"{url}/v1/documents/{doc_id}:batchUpdate",
                        json={"requests": requests}) as resp:
                    resp.raise_for_status()
            elif kind == "sheet":
                async with session.post(
                        f"{url}/v4/spreadsheets",
                        json={"properties": {
                            "title": entry["name"]
                        }}) as resp:
                    resp.raise_for_status()
                    sheet_id = (await resp.json())["spreadsheetId"]
                async with session.post(
                        f"{url}/v4/spreadsheets/{sheet_id}"
                        "/values/Sheet1:append",
                        json={"values": entry["rows"]}) as resp:
                    resp.raise_for_status()
            elif kind == "slide":
                async with session.post(f"{url}/v1/presentations",
                                        json={"title": entry["name"]}) as resp:
                    resp.raise_for_status()
            else:
                raise ValueError(f"unknown google-apps kind: {kind}")

    @staticmethod
    async def _seed_calendar(session: aiohttp.ClientSession, url: str,
                             entries: list[dict]) -> None:
        # Events are API objects, so they seed through events.insert and
        # take the ids the server mints; the manifest pins the times, which
        # is what the day directories are derived from.
        for entry in entries:
            async with session.post(
                    f"{url}/calendar/v3/calendars/primary/events",
                    json=entry) as resp:
                resp.raise_for_status()

    @staticmethod
    async def _seed_mail(session: aiohttp.ClientSession, url: str,
                         entries: list[dict]) -> None:
        # Messages are API objects: each manifest entry becomes an RFC822
        # payload inserted through messages.insert with
        # internalDateSource=dateHeader, so date dirs come from the
        # manifest, not the server clock.
        for entry in entries:
            raw = base64.urlsafe_b64encode(
                manifest_mime(entry).as_bytes()).decode()
            async with session.post(
                    f"{url}/gmail/v1/users/me/messages",
                    params={"internalDateSource": "dateHeader"},
                    json={
                        "raw": raw,
                        "labelIds": entry.get("labels", []),
                    }) as resp:
                resp.raise_for_status()

    @staticmethod
    async def _folder(session: aiohttp.ClientSession, url: str, name: str,
                      parent: str) -> str:
        query = (f"name='{name}' and '{parent}' in parents "
                 "and trashed=false")
        async with session.get(f"{url}/drive/v3/files",
                               params={"q": query}) as resp:
            resp.raise_for_status()
            files = (await resp.json())["files"]
        if files:
            return files[0]["id"]
        async with session.post(f"{url}/drive/v3/files",
                                json={
                                    "name": name,
                                    "mimeType": FOLDER_MIME,
                                    "parents": [parent],
                                }) as resp:
            resp.raise_for_status()
            return (await resp.json())["id"]

    def resource(self, mount: dict) -> GoogleDriveResource:
        return GoogleDriveResource(
            GoogleDriveConfig(client_id="integ",
                              refresh_token="integ",
                              api_base=self.url,
                              folder_id=self.folder_ids[mount["path"]]))

    def gdocs_resource(self) -> GDocsResource:
        return GDocsResource(
            GDocsConfig(client_id="integ",
                        refresh_token="integ",
                        api_base=self.url))

    def gsheets_resource(self) -> GSheetsResource:
        return GSheetsResource(
            GSheetsConfig(client_id="integ",
                          refresh_token="integ",
                          api_base=self.url))

    def gslides_resource(self) -> GSlidesResource:
        return GSlidesResource(
            GSlidesConfig(client_id="integ",
                          refresh_token="integ",
                          api_base=self.url))

    def gcal_resource(self) -> GCalResource:
        # today is pinned so the rolling window is the same on both hosts
        # and lands on the seeded events.
        return GCalResource(
            GCalConfig(client_id="integ",
                       refresh_token="integ",
                       api_base=self.url,
                       today="2026-02-11"))

    def gmail_resource(self) -> GmailResource:
        return GmailResource(
            GmailConfig(client_id="integ",
                        refresh_token="integ",
                        api_base=self.url))

    def cli_installs(self) -> dict[str, tuple[CLISpec, dict[str, object]]]:
        config: dict[str, object] = {
            "client_id": "integ",
            "refresh_token": "integ",
            "api_base": self.url,
        }
        if self.cli_scope is not None:
            config["folder_id"] = self.folder_ids[self.cli_scope]
        return {"gws": (cli_spec_for("gws"), config)}

    async def teardown(self) -> None:
        return None


class EmailService:
    """Points the email mount and the himalaya installs at the mail fake.

    The server is external (integ/server/mail/) and shared across runs. It is
    not GreenMail: the IMAP PASSWORD is the run, so two runs log in at the same
    address with the same username and see different mail. GreenMail cannot do
    that at all, since one account is one mailbox for every caller of the
    process, which is why a run had to purge the whole server between targets
    and why two hosts could never share one.

    Seeding is server-side. The fake reads the same shared manifest this
    adapter used to walk, so there is no IMAP APPEND loop here and no account
    provisioning: one POST states the accounts and the scenario.
    """

    def __init__(self, host: str, password: str) -> None:
        self.host = host
        # The run id, which every account authenticates with. Harness-side on
        # both arms and in no task file, exactly as the mount password was.
        self.password = password

    @classmethod
    def _manifest_name(cls, mail: str) -> str:
        """The fixture name inside the fake's manifest directory.

        Args:
            mail (str): the target's `mail` key, e.g. ``email/v1``.

        Raises:
            ValueError: the key names a directory the fake does not read.
        """
        prefix = f"{EMAIL_MANIFEST_DIR}/"
        if not mail.startswith(prefix):
            raise ValueError(
                f"email target mail={mail!r} must live under {prefix}")
        return mail[len(prefix):]

    @classmethod
    async def create(cls, run_id: str, target: dict) -> "EmailService":
        url = f'{os.environ["MAIL_URL"].rstrip("/")}/_run/{run_id}'
        body: dict = {"tenants": list(EMAIL_ACCOUNTS)}
        mail = target.get("mail")
        if mail:
            body["extras"] = {"manifest": cls._manifest_name(str(mail))}
        async with aiohttp.ClientSession() as session:
            async with session.post(f"{url}/reset", json=body) as resp:
                resp.raise_for_status()
        return cls(os.environ["EMAIL_HOST"], run_id)

    def resource(self, mount: dict) -> EmailResource:
        return EmailResource(
            EmailConfig(imap_host=self.host,
                        imap_port=EMAIL_IMAP_PORT,
                        smtp_host=self.host,
                        smtp_port=EMAIL_SMTP_PORT,
                        username=EMAIL_USERNAME,
                        password=self.password,
                        use_ssl=False))

    def cli_installs(self) -> dict[str, tuple[CLISpec, dict[str, object]]]:
        # h1 and h2 are the same spec installed twice: two head words,
        # two accounts, and neither shares the mount's account, so a
        # line's behavior proves which config it ran under.
        integ = {
            "imap_host": self.host,
            "imap_port": EMAIL_IMAP_PORT,
            "smtp_host": self.host,
            "smtp_port": EMAIL_SMTP_PORT,
            "username": EMAIL_USERNAME,
            "password": self.password,
            "use_ssl": False,
        }
        alpha = dict(integ, username=EMAIL_USERNAME_ALPHA)
        beta = dict(integ, username=EMAIL_USERNAME_BETA)
        return {
            "himalaya": (cli_spec_for("himalaya"), integ),
            "h1": (cli_spec_for("himalaya"), alpha),
            "h2": (cli_spec_for("himalaya"), beta),
        }

    async def teardown(self) -> None:
        return None


class OneDriveService:
    """Points onedrive mounts at the shared fake Microsoft Graph server.

    The server (integ/server/onedrive/) is external, Prisma-backed and shared
    across both hosts, replacing the per-run aiohttp server this adapter used
    to start in-process (and the TypeScript runner used to start as a PYTHON
    SUBPROCESS). Each target takes its own Graph ACCOUNT: the access token is
    what the fake reads the account off, which is the ordinary
    `Authorization: Bearer` header the Graph client already sends on every
    call, so no mirage-only header reaches the product code.

    Args:
        token (str): this target's account, sent as the bearer token.
        url (str): ONEDRIVE_URL origin, used as the Graph service root.
    """

    def __init__(self, token: str, url: str) -> None:
        self.token = token
        self.url = url

    @classmethod
    async def create(cls, run_id: str, target: dict) -> "OneDriveService":
        url = os.environ["ONEDRIVE_URL"].rstrip("/")
        return cls(f"{run_id}-{target['id']}", url)

    def resource(self, mount: dict) -> OneDriveResource:
        return OneDriveResource(
            OneDriveConfig(access_token=self.token,
                           graph_base_url=self.url,
                           key_prefix=mount.get("prefix")))

    async def teardown(self) -> None:
        return None


class Mem0Service:

    def __init__(self, endpoint: str,
                 process: asyncio.subprocess.Process) -> None:
        self.endpoint = endpoint
        self.process = process

    @classmethod
    async def create(cls) -> "Mem0Service":
        """Start the kit fake and read the port it announces.

        The adapter owns the process rather than reading a URL from the
        environment, which is what keeps ``--facet mem0`` free of CI setup.

        Returns:
            Mem0Service: the running fake.
        """
        endpoint, process = await start_kit_fake("mem0")
        return cls(endpoint, process)

    def resource(self, mount: dict) -> Mem0Resource:
        return Mem0Resource(
            Mem0Config(api_key="integ-key",
                       host=self.endpoint,
                       user_id="integ-user",
                       default_page_size=2))

    async def teardown(self) -> None:
        await stop_kit_fake(self.process)


class HttpService:
    """The fixture web server curl and wget fetch from.

    Exported through ``HTTP_ENDPOINT`` rather than a mount, because the cases
    name it as a URL in the command text (the ``{http}`` token) instead of a
    path. Owning the process here means ``--facet http`` needs no CI setup.
    The fake is a TypeScript kit service, so the interpreter is tsx.
    """

    def __init__(self, endpoint: str,
                 process: asyncio.subprocess.Process) -> None:
        self.endpoint = endpoint
        self.process = process

    @classmethod
    async def create(cls) -> "HttpService":
        endpoint, process = await start_kit_fake("http")
        os.environ["HTTP_ENDPOINT"] = endpoint
        return cls(endpoint, process)

    async def teardown(self) -> None:
        os.environ.pop("HTTP_ENDPOINT", None)
        await stop_kit_fake(self.process)


class DropboxService:
    """Points dropbox mounts at the shared fake Dropbox server.

    The server (integ/server/dropbox/) is external, Prisma-backed and shared
    across both hosts. Mounts sharing a ``bucket`` share one fake ACCOUNT (the
    -root target mounts three root_path subfolders of a single account,
    mirroring s3-prefix's shared bucket); distinct buckets get isolated
    accounts. An account is a tenant on the one server rather than a server of
    its own: the fake echoes the refresh token back from /oauth2/token as the
    access token, so the account rides the ordinary Authorization header the
    Dropbox RPC layer already sends. The run id is part of the token so two
    runs against the same shared server cannot see each other's writes.

    Fixtures seed through the workspace like every writable backend.

    Args:
        run_id (str): this run's id, which scopes every account name.
        url (str): DROPBOX_URL origin.
    """

    def __init__(self, run_id: str, url: str) -> None:
        self.run_id = run_id
        self.url = url

    @classmethod
    async def create(cls, run_id: str) -> "DropboxService":
        url = os.environ["DROPBOX_URL"].rstrip("/")
        return cls(run_id, url)

    def account(self, mount: dict) -> str:
        bucket = mount.get("bucket") or mount["path"].strip("/")
        return f"{self.run_id}-{bucket}"

    def resource(self, mount: dict) -> DropboxResource:
        return DropboxResource(
            # The fake supports full-text search_v2, so exercise grep/rg
            # narrowing in the battery.
            DropboxConfig(client_id="integ-client",
                          client_secret="integ-secret",
                          refresh_token=self.account(mount),
                          endpoint=self.url,
                          content_search=True,
                          root_path=mount.get("root") or "/"))

    async def teardown(self) -> None:
        return None


class HfService:
    """Points hf mounts at the shared fake Hugging Face hub.

    The server (integ/server/hf/) is external, Prisma-backed and shared across
    both hosts. Each run takes its own ACCOUNT: the client sends the user's
    token verbatim on every Hub call, so the token IS the account and the fake
    reads it off `Authorization`. That replaces naming the bucket
    `integ/<runid>-<mount>` inside one shared process, which isolated runs only
    as far as a name collision.

    Args:
        run_id (str): this run's id, which names its account.
        endpoint (str): HF_URL origin.
    """

    def __init__(self, run_id: str, endpoint: str) -> None:
        self.run_id = run_id
        self.endpoint = endpoint
        self.token = f"integ-hf-{run_id}"

    @classmethod
    async def create(cls, run_id: str) -> "HfService":
        return cls(run_id, os.environ["HF_URL"].rstrip("/"))

    def resource(self, mount: dict) -> HfBucketsResource:
        # Buckets auto-create on first touch, exactly as a real one does for a
        # namespace the token owns.
        return HfBucketsResource(
            HfBucketsConfig(
                bucket=f"integ/{mount['bucket']}",
                token=self.token,
                endpoint=self.endpoint,
                key_prefix=mount.get("prefix"),
            ))

    async def teardown(self) -> None:
        return None


class HfHubService:
    """Points hf_models / hf_datasets / hf_spaces mounts at the fake Hub.

    The server (integ/server/hf_hub/) is external, Prisma-backed and shared
    across both hosts, and the token IS the tenant: the client sends it
    verbatim on every Hub call and the fake reads it off `Authorization`, so
    a per-run token isolates two runs against one server.

    Unlike every object-store fake here, the fixture is not optional. A Hub
    mount NAMES a repository, and mounting one never creates it, so the
    repositories a target mounts must exist before the mount is built;
    `/reset` seeds them from integ/fixtures/hf-hub/v1.json. The file CONTENT
    then arrives the ordinary way, through each mount's own `fixture:` seed,
    which writes over the resource's commit path rather than behind it.

    Args:
        run_id (str): this run's id, which names its account.
        endpoint (str): HF_HUB_URL origin.
    """

    KINDS = {
        "hf_models": HfModelsResource,
        "hf_datasets": HfDatasetsResource,
        "hf_spaces": HfSpacesResource,
    }
    CONFIGS = {
        "hf_models": HfModelsConfig,
        "hf_datasets": HfDatasetsConfig,
        "hf_spaces": HfSpacesConfig,
    }

    def __init__(self, run_id: str, endpoint: str) -> None:
        self.run_id = run_id
        self.endpoint = endpoint
        self.token = f"integ-hfhub-{run_id}"

    @classmethod
    async def create(cls, run_id: str) -> "HfHubService":
        endpoint = os.environ["HF_HUB_URL"].rstrip("/")
        token = f"integ-hfhub-{run_id}"
        async with aiohttp.ClientSession() as session:
            async with session.post(f"{endpoint}/reset",
                                    json={
                                        "tenants": [token],
                                        "fixture": "v1"
                                    }) as resp:
                resp.raise_for_status()
        return cls(run_id, endpoint)

    def resource(self, mount: dict) -> object:
        kind = mount["resource"]
        config = self.CONFIGS[kind](
            repo_id=mount["repo"],
            token=self.token,
            endpoint=self.endpoint,
            key_prefix=mount.get("prefix"),
        )
        return self.KINDS[kind](config)

    def cli_installs(self) -> dict[str, tuple[CLISpec, dict[str, object]]]:
        return {
            "hf": (cli_spec_for("hf"), {
                "token": self.token,
                "endpoint": self.endpoint,
            }),
        }

    async def teardown(self) -> None:
        return None


class BoxService:
    """Points box mounts at the shared fake Box API server.

    The server (integ/server/box/) is external, Prisma-backed and shared
    across both hosts. Each run takes its own ACCOUNT: the vendor's
    developer-token flow sends a pre-fetched access token verbatim, so the
    token IS the account and the fake reads it off `Authorization`. That
    replaces naming the mount folder `integ-<runid>-<mount>` inside one shared
    account, which isolated runs only as far as a name collision.

    Box is read-only through the workspace, so the harness tee-seeding cannot
    run and the fixture is uploaded over the Box API instead, exactly as the
    TypeScript host does it.

    Args:
        run_id (str): this run's id, which names its account.
        url (str): BOX_URL origin.
    """

    def __init__(self, run_id: str, url: str) -> None:
        self.run_id = run_id
        self.url = url
        self.token = f"integ-box-{run_id}"
        # Mount path -> the id of the folder that mount is rooted at. Filled
        # in by `create`, because seeding is async and `build_box` is not.
        self.folders: dict[str, str] = {}

    @classmethod
    async def create(cls, run_id: str, target: dict) -> "BoxService":
        service = cls(run_id, os.environ["BOX_URL"].rstrip("/"))
        for mount in target["mounts"]:
            service.folders[mount["path"]] = await service.seed(mount)
        return service

    def _auth(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}

    async def _folder(self, session: aiohttp.ClientSession, parent_id: str,
                      name: str) -> str:
        """Create a folder, or find the existing one of that name.

        Args:
            session (aiohttp.ClientSession): open session against the fake.
            parent_id (str): id of the folder to create under.
            name (str): the folder's name.
        """
        async with session.post(f"{self.url}/2.0/folders",
                                headers=self._auth(),
                                json={
                                    "name": name,
                                    "parent": {
                                        "id": parent_id
                                    }
                                }) as resp:
            if resp.status == 201:
                return (await resp.json())["id"]
            if resp.status != 409:
                raise RuntimeError(
                    f"box folder create {name} -> {resp.status}")
        async with session.get(
                f"{self.url}/2.0/folders/{parent_id}/items?limit=1000",
                headers=self._auth()) as resp:
            entries = (await resp.json())["entries"]
        for entry in entries:
            if entry["type"] == "folder" and entry["name"] == name:
                return entry["id"]
        raise RuntimeError(f"box folder {name} neither created nor found")

    async def _upload(self, session: aiohttp.ClientSession, folder_id: str,
                      name: str, content: bytes) -> None:
        """Upload one file with the vendor's multipart shape.

        Args:
            session (aiohttp.ClientSession): open session against the fake.
            folder_id (str): id of the folder to upload into.
            name (str): the file's name.
            content (bytes): the file's bytes.
        """
        form = aiohttp.FormData()
        form.add_field("attributes",
                       json.dumps({
                           "name": name,
                           "parent": {
                               "id": folder_id
                           }
                       }))
        form.add_field("file",
                       content,
                       filename=name,
                       content_type="application/octet-stream")
        async with session.post(f"{self.url}/2.0/files/content",
                                headers=self._auth(),
                                data=form) as resp:
            if resp.status != 201:
                raise RuntimeError(f"box upload {name} -> {resp.status}")

    async def seed(self, mount: dict) -> str:
        """Create this mount's root folder and upload its fixture into it.

        Args:
            mount (dict): the mount entry from targets.json.
        """
        async with aiohttp.ClientSession() as session:
            folder_id = await self._folder(session, "0", mount["folder"])
            seed = mount.get("seed")
            if seed:
                base = (Path(__file__).resolve().parents[3] / "fixtures" /
                        seed)
                for src in sorted(base.rglob("*")):
                    if not src.is_file():
                        continue
                    rel = src.relative_to(base).as_posix()
                    parts = rel.split("/")
                    parent_id = folder_id
                    for name in parts[:-1]:
                        parent_id = await self._folder(session, parent_id,
                                                       name)
                    await self._upload(session, parent_id, parts[-1],
                                       src.read_bytes())
            if seed == "files/v1":
                # A weblink beside the fixture: sizeless and content-free, so
                # listings must hide it and a direct stat must ENOENT.
                async with session.post(f"{self.url}/2.0/web_links",
                                        headers=self._auth(),
                                        json={
                                            "name": "homepage",
                                            "url": "https://example.com/",
                                            "parent": {
                                                "id": folder_id
                                            },
                                        }) as resp:
                    if resp.status != 201:
                        raise RuntimeError(
                            f"box web_link seed failed: {resp.status}")
        return folder_id

    def resource(self, mount: dict) -> BoxResource:
        return BoxResource(
            BoxConfig(
                access_token=self.token,
                endpoint=self.url,
                root_folder_id=self.folders[mount["path"]],
                # The fake supports name+content search, so exercise grep/rg
                # push-down narrowing in the battery.
                content_search=True,
            ))

    async def teardown(self) -> None:
        return None


class SlackService:
    """Points slack mounts at the shared fake Slack Web API server.

    The server (integ/server/slack/) is external, Prisma-backed, and shared
    across both hosts; /reset re-seeds it to the fixture. The mount uses a
    user token (xoxp-) so the grep/rg search push-down runs against the fake's
    search.messages / search.files endpoints.

    Args:
        url (str): SLACK_URL origin (methods live under /api).
    """

    def __init__(self, url: str, workspace: str) -> None:
        self.url = url
        self.workspace = workspace

    @classmethod
    async def create(cls, run_id: str) -> "SlackService":
        url = os.environ["SLACK_URL"].rstrip("/")
        service = cls(url, f"integ-{run_id}")
        async with aiohttp.ClientSession() as session:
            async with session.post(f"{url}/reset",
                                    json={"tenants":
                                          [service.workspace]}) as resp:
                resp.raise_for_status()
        return service

    def _tokens(self) -> tuple[str, str]:
        """The two tokens one workspace is reached with.

        Both carry the same workspace; only the actor type differs, and the
        fake strips that prefix to land them on one tenant. They stay distinct
        because search.* refuses anything but a user token, exactly as real
        Slack does, and collapsing them would make that refusal untestable.

        Returns:
            tuple[str, str]: the bot token and the user (search) token.
        """
        return f"xoxb-{self.workspace}", f"xoxp-{self.workspace}"

    def resource(self, mount: dict) -> SlackResource:
        bot, search = self._tokens()
        return SlackResource(
            SlackConfig(token=bot,
                        search_token=search,
                        base_url=f"{self.url}/api"))

    def cli_installs(self) -> dict[str, tuple[CLISpec, dict[str, object]]]:
        return {
            "slack": (cli_spec_for("slack"), {
                "token": self._tokens()[0],
                "search_token": self._tokens()[1],
                "base_url": f"{self.url}/api",
            }),
        }

    async def teardown(self) -> None:
        return None


class GitHubService:
    """Points github mounts at the fake api.github.com server.

    The server (integ/server/github) is a kit fake running out of process
    on GITHUB_URL, mirroring the fake Slack and Google Workspace servers
    and shared with the typescript host. It used to be out of process by
    necessity — GitHubResource fetched the repo tree with a blocking
    urlopen from its constructor, which would starve an aiohttp fake on
    the runner's loop. That constraint is gone now that the constructor
    touches no network and the tree hydrates on first read; sharing one
    fake across both hosts is why it stays external.

    Args:
        url (str): GITHUB_URL origin the fake is listening on.
    """

    def __init__(self, url: str) -> None:
        self.url = url

    @classmethod
    async def create(cls) -> "GitHubService":
        return cls(os.environ["GITHUB_URL"].rstrip("/"))

    async def reset(self) -> None:
        """Drop every write since startup, restoring the seeded state.

        The write battery runs once per host against one shared fake, so it
        starts from the seed rather than from the other host's writes.
        """
        async with aiohttp.ClientSession() as session:
            async with session.post(f"{self.url}/reset") as resp:
                resp.raise_for_status()

    async def resource(self, mount: dict) -> GitHubResource:
        owner, _, repo = mount["repo"].partition("/")
        return GitHubResource(
            GitHubConfig(token="ghp-integ",
                         owner=owner,
                         repo=repo,
                         base_url=self.url))

    def cli_installs(self) -> dict[str, tuple[CLISpec, dict[str, object]]]:
        return {
            "gh": (cli_spec_for("gh"), {
                "token": "ghp-integ",
                "base_url": self.url,
                "repo": GH_CLI_REPO,
                "branch": "main",
            }),
        }

    async def teardown(self) -> None:
        return None


class DifyService:
    """Points dify mounts at the kit fake for the knowledge base.

    The adapter owns the process for the reason the mem0 one does: the fake is
    a TypeScript kit service now, and spawning it here keeps ``--facet dify``
    free of CI setup.

    Args:
        base (str): the fake's origin.
        dataset (str): the dataset id the mounts read.
        process (asyncio.subprocess.Process): the running fake.
    """

    def __init__(self, base: str, dataset: str,
                 process: asyncio.subprocess.Process) -> None:
        self.base = base
        self.dataset = dataset
        self.process = process

    @classmethod
    async def create(cls, target: dict) -> "DifyService":
        base, process = await start_kit_fake("dify")
        return cls(base, target.get("dataset", "kb-7f3a"), process)

    def resource(self, mount: dict) -> DifyResource:
        return DifyResource(
            DifyConfig(api_key="integ-key",
                       base_url=self.base,
                       dataset_id=self.dataset))

    async def teardown(self) -> None:
        await stop_kit_fake(self.process)


class TrelloService:
    """Points trello mounts at the shared fake Trello REST API server.

    The server (integ/server/trello/) is external, Prisma-backed, and
    shared across both hosts; /reset re-seeds it to the fixture, so the
    write cases see the same state on every run and on either host.

    Args:
        base (str): TRELLO_URL origin.
    """

    def __init__(self, base: str) -> None:
        self.base = base

    @classmethod
    async def create(cls) -> "TrelloService":
        base = os.environ["TRELLO_URL"].rstrip("/")
        async with aiohttp.ClientSession() as session:
            async with session.post(f"{base}/reset") as resp:
                resp.raise_for_status()
        return cls(base)

    def resource(self, mount: dict) -> TrelloResource:
        return TrelloResource(
            TrelloConfig(api_key="integ-key",
                         api_token="integ-token",
                         base_url=self.base))

    async def teardown(self) -> None:
        return None


class DiscordService:
    """Points discord mounts at the shared fake discord.com/api server.

    The server (integ/server/discord/) is external and shared across both
    hosts, so /reset re-seeds it to the fixture before this run's cases.
    It mirrors the documented shapes: newest-first message pages,
    after/limit pagination, and a CDN route that serves attachment bytes
    without the bot token.

    Args:
        base (str): DISCORD_URL origin.
    """

    def __init__(self, base: str) -> None:
        self.base = base

    @classmethod
    async def create(cls) -> "DiscordService":
        base = os.environ["DISCORD_URL"].rstrip("/")
        async with aiohttp.ClientSession() as session:
            async with session.post(f"{base}/reset") as resp:
                resp.raise_for_status()
        return cls(base)

    def resource(self, mount: dict) -> DiscordResource:
        return DiscordResource(
            DiscordConfig(token="integ-bot-token",
                          base_url=f"{self.base}/api/v10"))

    def cli_installs(self) -> dict[str, tuple[CLISpec, dict[str, object]]]:
        return {
            "discord": (cli_spec_for("discord"), {
                "token": "integ-bot-token",
                "base_url": f"{self.base}/api/v10",
            }),
        }

    async def teardown(self) -> None:
        return None


class LinearService:
    """Points linear mounts at the shared fake Linear GraphQL server.

    LINEAR_URL is an origin like every other service's variable, so the
    graphql path is appended here rather than carried in the env var; only
    /reset is reached on the bare origin.

    Args:
        base (str): LINEAR_URL origin.
    """

    def __init__(self, base: str) -> None:
        self.base = base
        self.graphql = f"{base}/graphql"

    @classmethod
    async def create(cls) -> "LinearService":
        base = os.environ["LINEAR_URL"].rstrip("/")
        async with aiohttp.ClientSession() as session:
            async with session.post(f"{base}/reset") as resp:
                resp.raise_for_status()
        return cls(base)

    def resource(self, mount: dict) -> LinearResource:
        return LinearResource(
            LinearConfig(api_key="integ-key", base_url=self.graphql))

    def cli_installs(self) -> dict[str, tuple[CLISpec, dict[str, object]]]:
        return {
            "linear": (cli_spec_for("linear"), {
                "api_key": "integ-key",
                "base_url": self.graphql,
            }),
        }

    async def teardown(self) -> None:
        return None


class JaegerService:
    """Points jaeger mounts at a real jaeger all-in-one container.

    The container is external and seeded over OTLP by
    integ/server/jaeger_seed.py, so trace ids and timestamps are fixed.
    """

    def __init__(self, host: str) -> None:
        self.host = host

    @classmethod
    async def create(cls) -> "JaegerService":
        return cls(os.environ["JAEGER_URL"])

    def resource(self, mount: dict) -> JaegerResource:
        return JaegerResource(JaegerConfig(host=self.host))

    async def teardown(self) -> None:
        return None


class LangfuseService:
    """Points langfuse mounts at a real self-hosted Langfuse instance.

    The stack (web + worker + postgres + clickhouse + redis + blob store) is
    external, brought up from integ/server/langfuse_compose.yml and seeded by
    integ/server/langfuse_seed.py, so the project keys are fixed constants.
    """

    def __init__(self, host: str, public_key: str, secret_key: str) -> None:
        self.host = host
        self.public_key = public_key
        self.secret_key = secret_key

    @classmethod
    async def create(cls) -> "LangfuseService":
        return cls(
            os.environ["LANGFUSE_URL"],
            os.environ.get("LANGFUSE_PUBLIC_KEY", "pk-lf-mirage-integ"),
            os.environ.get("LANGFUSE_SECRET_KEY", "sk-lf-mirage-integ"),
        )

    def resource(self, mount: dict) -> LangfuseResource:
        return LangfuseResource(
            LangfuseConfig(public_key=self.public_key,
                           secret_key=self.secret_key,
                           host=self.host))

    async def teardown(self) -> None:
        return None


class SharePointService:
    """Points sharepoint mounts at the shared fake Microsoft Graph server.

    Same server and same per-target account as :class:`OneDriveService`; what
    differs is that a SharePoint mount names a DRIVE, and which drives a site
    has is deployment state. That used to be an in-process `add_drive` call on
    a server this adapter owned; with the server shared it crosses a socket, as
    `PUT /drives/{key}`. The prefix folders are created the same way they
    always were, just over Graph's own mkdir endpoint instead of by reaching
    into the server's dict.

    Args:
        token (str): this target's account, sent as the bearer token.
        url (str): ONEDRIVE_URL origin, used as the Graph service root.
    """

    def __init__(self, token: str, url: str) -> None:
        self.token = token
        self.url = url

    @classmethod
    async def create(cls, run_id: str, target: dict) -> "SharePointService":
        service = cls(f"{run_id}-{target['id']}",
                      os.environ["ONEDRIVE_URL"].rstrip("/"))
        for mount in target["mounts"]:
            await service.provision(mount)
        return service

    def _auth(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}

    async def provision(self, mount: dict) -> None:
        """Declare this mount's drive and create its prefix folders.

        Args:
            mount (dict): the mount entry from targets.json.
        """
        drive = mount["drive"]
        async with aiohttp.ClientSession() as session:
            async with session.put(f"{self.url}/drives/{drive}",
                                   headers=self._auth()) as resp:
                if resp.status != 200:
                    raise RuntimeError(
                        f"sharepoint drive {drive} -> {resp.status}")
            parent = ""
            for name in (mount.get("prefix") or "").strip("/").split("/"):
                if not name:
                    continue
                # One level at a time: Graph's mkdir 404s when the parent is
                # missing, and `replace` on a folder returns the existing one
                # with its children intact, which is what makes this idempotent
                # across the two mounts of sharepoint-prefix that share a
                # `team/reports` ancestor.
                stem = f"{self.url}/drives/{drive}/root"
                url = f"{stem}:/{parent}:/children" if parent \
                    else f"{stem}/children"
                body = {
                    "name": name,
                    "folder": {},
                    "@microsoft.graph.conflictBehavior": "replace",
                }
                async with session.post(url, headers=self._auth(),
                                        json=body) as resp:
                    if resp.status != 200:
                        raise RuntimeError(
                            f"sharepoint mkdir {name} -> {resp.status}")
                parent = f"{parent}/{name}" if parent else name

    def resource(self, mount: dict) -> SharePointResource:
        return SharePointResource(
            SharePointConfig(access_token=self.token,
                             graph_base_url=self.url,
                             site="Main",
                             drive=mount["drive"],
                             key_prefix=mount.get("prefix")))

    async def teardown(self) -> None:
        return None


class NotionService:
    """Points notion mounts at the shared fake Notion REST API.

    The server (integ/server/notion/) is external, Prisma-backed and shared
    across both hosts. The token doubles as the workspace id, the way a real
    Notion integration token scopes you to one workspace.

    The token is NOT minted per run, and notion is the only kit fake whose
    token cannot be: it is observable. `ntn auth token` prints the CLI's
    configured value without contacting the server, integ/cli/ntn.json pins
    that literal, and integ/ntn_conformance.ts asserts the same line against
    the real ntn binary, which it configures with this same fixed token. A
    per-run token would make those two runs print different things with one
    golden between them.

    So the RUN is the axis that separates the hosts, and it rides the base URL
    as a leading `/_run/<id>` segment. A header or a query parameter cannot do
    this job: the mount hands its base URL to the resource and never sees the
    request again. With the run in the URL the two hosts keep the one shared
    token, get a SQLite file each, and can reset concurrently.

    Args:
        url (str): NOTION_URL origin (the REST surface lives under /v1).
        token (str): the shared workspace token.
        run_id (str): this run's id, which names its own server-side file.
    """

    def __init__(self, url: str, token: str, run_id: str) -> None:
        self.url = url
        self.token = token
        self.run_id = run_id

    @property
    def base(self) -> str:
        """Return the run-scoped origin every mount and CLI is pointed at.

        Returns:
            str: the origin with this run's `/_run/<id>` prefix.
        """
        return f"{self.url}/_run/{self.run_id}"

    @classmethod
    async def create(cls, run_id: str) -> "NotionService":
        url = os.environ["NOTION_URL"].rstrip("/")
        token = NOTION_TOKEN
        made = cls(url, token, run_id)
        async with aiohttp.ClientSession() as session:
            async with session.post(f"{made.base}/reset",
                                    json={"tenants": [token]}) as resp:
                resp.raise_for_status()
        return made

    def resource(self, mount: dict) -> NotionResource:
        return NotionResource(config=NotionConfig(api_key=self.token,
                                                  base_url=f"{self.base}/v1"))

    def cli_installs(self) -> dict[str, tuple[CLISpec, dict[str, object]]]:
        return {
            "ntn": (cli_spec_for("ntn"), {
                "api_key": self.token,
                "base_url": f"{self.base}/v1",
            }),
        }

    async def teardown(self) -> None:
        return None


LANCEDB_ROWS = [
    {
        "id": 1,
        "label": "cat",
        "kind": "big",
        "name": "a big orange cat"
    },
    {
        "id": 2,
        "label": "cat",
        "kind": "small",
        "name": "a small grey cat"
    },
    {
        "id": 3,
        "label": "dog",
        "kind": "big",
        "name": "a big brown dog"
    },
    {
        "id": 4,
        "label": "dog",
        "kind": "small",
        "name": "a small white dog"
    },
]

# One group holding far more rows than the window facet's row cap, so a
# glob for a row past the cap can only be answered by narrowing the query.
LANCEDB_WIDE_CAP = 5
LANCEDB_WIDE_ROWS = [{
    "id": f"doc-{i:03d}",
    "label": "all",
    "name": f"row {i}"
} for i in range(40)]


class LanceDBService:

    def __init__(self, uri: str, window: bool) -> None:
        self.uri = uri
        self.window = window

    @classmethod
    async def create(cls, target: dict) -> "LanceDBService":
        window = target.get("facet") == "window"
        uri = tempfile.mkdtemp(prefix="mirage-integ-lancedb-")
        db = lancedb.connect(uri)
        if window:
            db.create_table("wide", data=LANCEDB_WIDE_ROWS)
        else:
            db.create_table("animals", data=LANCEDB_ROWS)
        return cls(uri, window)

    def resource(self, mount: dict) -> LanceDBResource:
        if self.window:
            return LanceDBResource(
                LanceDBConfig(uri=self.uri,
                              table="wide",
                              group_by=["label"],
                              id_column="id",
                              title_column="name",
                              text_column="name",
                              max_rows=LANCEDB_WIDE_CAP))
        return LanceDBResource(
            LanceDBConfig(uri=self.uri,
                          group_by=["label", "kind"],
                          id_column="id",
                          title_column="name",
                          text_column="name"))

    async def teardown(self) -> None:
        shutil.rmtree(self.uri, ignore_errors=True)


QDRANT_EMBED_DIM = 8

QDRANT_ROWS = [
    (1, "cat", "big", "a big orange cat"),
    (2, "cat", "small", "a small grey cat"),
    (3, "dog", "big", "a big brown dog"),
    (4, "dog", "small", "a small white dog"),
]

# Far more points than the window facet's row cap, all in one group, and
# ids whose text straddles a scroll page so a narrowed listing has to page.
QDRANT_WIDE_CAP = 5
QDRANT_WIDE_POINTS = 600


class QdrantService:

    def __init__(self, host: str, port: int, collection: str,
                 window: bool) -> None:
        self.host = host
        self.port = port
        self.collection = collection
        self.window = window

    @classmethod
    async def create(cls, target: dict) -> "QdrantService":
        window = target.get("facet") == "window"
        host = os.environ.get("QDRANT_HOST", "localhost")
        port = int(os.environ.get("QDRANT_PORT", "6333"))
        collection = f"mirage-integ-{uuid.uuid4().hex[:8]}"
        client = AsyncQdrantClient(host=host, port=port)
        try:
            await client.create_collection(
                collection,
                vectors_config=models.VectorParams(
                    size=QDRANT_EMBED_DIM, distance=models.Distance.COSINE))
            if window:
                await client.upsert(
                    collection,
                    points=[
                        models.PointStruct(id=i,
                                           vector=[0.1] * QDRANT_EMBED_DIM,
                                           payload={
                                               "label": "all",
                                               "name": f"row {i}"
                                           })
                        for i in range(1, QDRANT_WIDE_POINTS + 1)
                    ])
            else:
                await client.upsert(
                    collection,
                    points=[
                        models.PointStruct(
                            id=i,
                            vector=[0.1] * QDRANT_EMBED_DIM,
                            payload={
                                "label":
                                label,
                                "kind":
                                kind,
                                "name":
                                name,
                                "image_bytes":
                                base64.b64encode(f"PNG-{i}".encode()).decode(),
                            }) for i, label, kind, name in QDRANT_ROWS
                    ])
            for field in (("label", ) if window else ("label", "kind")):
                await client.create_payload_index(
                    collection,
                    field_name=field,
                    field_schema=models.PayloadSchemaType.KEYWORD)
            await asyncio.sleep(2)
        finally:
            await client.close()
        return cls(host, port, collection, window)

    def resource(self, mount: dict) -> QdrantResource:
        if self.window:
            return QdrantResource(
                QdrantConfig(host=self.host,
                             port=self.port,
                             collection=self.collection,
                             group_by=["label"],
                             id_field="id",
                             text_field="name",
                             max_rows=QDRANT_WIDE_CAP))
        return QdrantResource(
            QdrantConfig(host=self.host,
                         port=self.port,
                         collection=self.collection,
                         group_by=["label", "kind"],
                         id_field="id",
                         text_field="name",
                         blob_field="image_bytes",
                         blob_ext="png"))

    async def teardown(self) -> None:
        client = AsyncQdrantClient(host=self.host, port=self.port)
        try:
            await client.delete_collection(self.collection)
        finally:
            await client.close()


CHROMA_EMBED_DIM = 8


def _chroma_embedding(position: int) -> list[float]:
    vector = [0.0] * CHROMA_EMBED_DIM
    vector[position % CHROMA_EMBED_DIM] = 1.0
    return vector


class ChromaService:

    def __init__(self, host: str, port: int, collection_name: str) -> None:
        self.host = host
        self.port = port
        self.collection_name = collection_name

    @classmethod
    async def create(cls) -> "ChromaService":
        host = os.environ.get("CHROMA_HOST", "localhost")
        port = int(os.environ.get("CHROMA_PORT", "8000"))
        collection_name = f"mirage-integ-{uuid.uuid4().hex[:8]}"
        seed_path = (Path(__file__).resolve().parents[3] / "server" /
                     "chroma_seed.json")
        seed = json.loads(seed_path.read_text())
        encoded = base64.b64encode(
            gzip.compress(json.dumps(seed["path_tree"]).encode())).decode()
        ids = ["__path_tree__"]
        documents = [encoded]
        metadatas: list[dict] = [{"kind": "path_tree"}]
        embeddings = [_chroma_embedding(0)]
        position = 1
        for chunks in seed["chunks"].values():
            for chunk in chunks:
                slug = chunk["metadata"]["page_slug"]
                index = chunk["metadata"]["chunk_index"]
                ids.append(f"{slug}#{index}")
                documents.append(chunk["document"])
                metadatas.append(chunk["metadata"])
                embeddings.append(_chroma_embedding(position))
                position += 1
        client = await chromadb.AsyncHttpClient(host=host, port=port)
        collection = await client.create_collection(collection_name)
        await collection.add(ids=ids,
                             documents=documents,
                             metadatas=metadatas,
                             embeddings=embeddings)
        return cls(host, port, collection_name)

    def resource(self, mount: dict) -> ChromaResource:
        return ChromaResource(
            config=ChromaConfig(host=self.host,
                                port=self.port,
                                collection_name=self.collection_name))

    async def teardown(self) -> None:
        client = await chromadb.AsyncHttpClient(host=self.host, port=self.port)
        await client.delete_collection(self.collection_name)


MONGODB_DB = "mirage_integ"

MONGODB_BOOKS = [
    {
        "_id": 1,
        "title": "alpha",
        "author": "ada",
        "year": 2020,
        "tags": ["fiction", "classic"],
        "rating": 4.5,
    },
    {
        "_id": 2,
        "title": "beta",
        "author": "ben",
        "year": 2021,
        "tags": ["fiction"],
        "rating": 3.2,
    },
    {
        "_id": 3,
        "title": "gamma",
        "author": "cara",
        "year": 2022,
        "rating": 5.0,
    },
    {
        "_id": 4,
        "title": "delta",
        "author": "ada",
        "year": 2023,
        "tags": ["history"],
        "rating": 4.0,
    },
    {
        "_id": 5,
        "title": "epsilon",
        "author": "ben",
        "year": 2024,
        "rating": 2.5,
    },
]

MONGODB_AUTHORS = [
    {
        "_id": 1,
        "name": "ada",
        "books": 2
    },
    {
        "_id": 2,
        "name": "ben",
        "books": 2
    },
    {
        "_id": 3,
        "name": "cara",
        "books": 1
    },
]


class MongoDBService:

    def __init__(self, uri: str) -> None:
        self.uri = uri

    @classmethod
    async def create(cls) -> "MongoDBService":
        uri = os.environ["MONGODB_URI"]
        client: AsyncMongoClient = AsyncMongoClient(uri)
        try:
            await client.drop_database(MONGODB_DB)
            db = client[MONGODB_DB]
            await db["books"].insert_many([dict(d) for d in MONGODB_BOOKS])
            await db["authors"].insert_many([dict(d) for d in MONGODB_AUTHORS])
            await db.create_collection(
                "recent_books",
                viewOn="books",
                pipeline=[{
                    "$match": {
                        "year": {
                            "$gte": 2022
                        }
                    }
                }],
            )
        finally:
            await client.close()
        return cls(uri)

    def resource(self, mount: dict) -> MongoDBResource:
        return MongoDBResource(
            config=MongoDBConfig(uri=self.uri, databases=[MONGODB_DB]))

    async def teardown(self) -> None:
        return None


POSTGRES_BOOKS = [
    (1, "alpha", "ada", 2020, 4.5),
    (2, "beta", "ben", 2021, 3.2),
    (3, "gamma", "cara", 2022, 5.0),
    (4, "delta", "ada", 2023, 4.0),
    (5, "epsilon", "ben", 2024, 2.5),
]

POSTGRES_AUTHORS = [
    (1, "ada", 2),
    (2, "ben", 2),
    (3, "cara", 1),
]


class PostgresService:

    def __init__(self, dsn: str) -> None:
        self.dsn = dsn

    @classmethod
    async def create(cls) -> "PostgresService":
        dsn = os.environ["POSTGRES_DSN"]
        conn = await asyncpg.connect(dsn)
        try:
            await conn.execute("DROP VIEW IF EXISTS recent_books")
            await conn.execute("DROP TABLE IF EXISTS books")
            await conn.execute("DROP TABLE IF EXISTS authors")
            await conn.execute(
                "CREATE TABLE books (id int PRIMARY KEY, title text, "
                "author text, year int, rating double precision)")
            await conn.execute("CREATE TABLE authors (id int PRIMARY KEY, "
                               "name text, books int)")
            await conn.executemany(
                "INSERT INTO books (id, title, author, year, rating) "
                "VALUES ($1, $2, $3, $4, $5)", POSTGRES_BOOKS)
            await conn.executemany(
                "INSERT INTO authors (id, name, books) VALUES ($1, $2, $3)",
                POSTGRES_AUTHORS)
            await conn.execute("CREATE VIEW recent_books AS SELECT * FROM "
                               "books WHERE year >= 2022")
            await conn.execute("ANALYZE books")
            await conn.execute("ANALYZE authors")
            # A quoted dot-prefixed schema is legal; the kit must keep it
            # out of listings, not advertise a path stat reports absent.
            await conn.execute('DROP SCHEMA IF EXISTS ".hidden" CASCADE')
            await conn.execute('CREATE SCHEMA ".hidden"')
            await conn.execute(
                'CREATE TABLE ".hidden".ghost (id int PRIMARY KEY)')
        finally:
            await conn.close()
        return cls(dsn)

    def resource(self, mount: dict) -> PostgresResource:
        return PostgresResource(PostgresConfig(dsn=self.dsn,
                                               max_read_rows=200))

    async def teardown(self) -> None:
        return None


Service = (S3Service | OneDriveService | SharePointService | Mem0Service
           | SSHService | PostgresService | MongoDBService | ChromaService
           | QdrantService | LanceDBService | NotionService
           | NextcloudService | GwsService | HfService | HfHubService
           | BoxService
           | DropboxService | GridFSService | SlackService | TrelloService
           | LinearService | DifyService | DatabricksVolumeService
           | LangfuseService | JaegerService)


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


def build_gridfs(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, GridFSService)
    return service.resource(mount), _noop


def build_databricks_volume(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, DatabricksVolumeService)
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


def build_mem0(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, Mem0Service)
    return service.resource(mount), _noop


def build_postgres(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, PostgresService)
    resource = service.resource(mount)
    return resource, resource.accessor.close


def build_mongodb(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, MongoDBService)
    resource = service.resource(mount)
    return resource, resource.accessor.close


def build_chroma(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, ChromaService)
    return service.resource(mount), _noop


def build_qdrant(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, QdrantService)
    resource = service.resource(mount)
    return resource, resource.accessor.close


def build_lancedb(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, LanceDBService)
    resource = service.resource(mount)
    return resource, resource.accessor.close


def build_notion(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, NotionService)
    return service.resource(mount), _noop


def build_hf(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, HfService)
    return service.resource(mount), _noop


def build_hf_hub(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, HfHubService)
    return service.resource(mount), _noop


def build_box(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, BoxService)
    return service.resource(mount), _noop


def build_dropbox(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, DropboxService)
    return service.resource(mount), _noop


def build_dify(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, DifyService)
    return service.resource(mount), _noop


def build_trello(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, TrelloService)
    return service.resource(mount), _noop


def build_discord(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, DiscordService)
    return service.resource(mount), _noop


def build_linear(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, LinearService)
    return service.resource(mount), _noop


def build_jaeger(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, JaegerService)
    return service.resource(mount), _noop


def build_langfuse(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, LangfuseService)
    return service.resource(mount), _noop


def build_ssh(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, SSHService)
    return service.resource(mount), _noop


def build_gdrive(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, GwsService)
    return service.resource(mount), _noop


def build_gdocs(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, GwsService)
    return service.gdocs_resource(), _noop


def build_gsheets(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, GwsService)
    return service.gsheets_resource(), _noop


def build_gslides(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, GwsService)
    return service.gslides_resource(), _noop


def build_email(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, EmailService)
    return service.resource(mount), _noop


def build_gcal(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, GwsService)
    return service.gcal_resource(), _noop


def build_gmail(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, GwsService)
    return service.gmail_resource(), _noop


def build_nextcloud(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, NextcloudService)
    return service.resource(mount), _noop


async def build_github(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, GitHubService)
    return await service.resource(mount), _noop


def build_slack(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, SlackService)
    return service.resource(mount), _noop


# Backends reachable with dummy credentials and no server, for the arg-error
# battery: an invalid -maxdepth/-mindepth/-size/-mtime must be rejected while
# flags are parsed, before any network call, so construction is all these
# targets ever need. github, notion and hf_buckets are absent on purpose:
# github needs a live repo at construct, notion an OAuth provider, and
# hf_buckets validates the bucket id.
ARG_ERROR_RESOURCES: dict[str, tuple[type, type, dict[str, object]]] = {
    "databricks": (DatabricksVolumeResource, DatabricksVolumeConfig, {
        "host": "h",
        "token": "t",
        "catalog": "c",
        "schema": "s",
        "volume": "v",
    }),
    "discord": (DiscordResource, DiscordConfig, {
        "token": "x"
    }),
    "email": (EmailResource, EmailConfig, {
        "imap_host": "h",
        "smtp_host": "h",
        "username": "u",
        "password": "p",
    }),
    "gdocs": (GDocsResource, GDocsConfig, {
        "client_id": "c",
        "refresh_token": "r"
    }),
    "gdrive": (GoogleDriveResource, GoogleDriveConfig, {
        "client_id": "c",
        "refresh_token": "r"
    }),
    "gmail": (GmailResource, GmailConfig, {
        "client_id": "c",
        "refresh_token": "r"
    }),
    "gsheets": (GSheetsResource, GSheetsConfig, {
        "client_id": "c",
        "refresh_token": "r"
    }),
    "gslides": (GSlidesResource, GSlidesConfig, {
        "client_id": "c",
        "refresh_token": "r"
    }),
    "langfuse": (LangfuseResource, LangfuseConfig, {
        "public_key": "p",
        "secret_key": "s"
    }),
    "linear": (LinearResource, LinearConfig, {
        "api_key": "k"
    }),
    "mem0": (Mem0Resource, Mem0Config, {
        "api_key": "k",
        "user_id": "u"
    }),
    "onedrive": (OneDriveResource, OneDriveConfig, {
        "access_token": "t"
    }),
    "sharepoint": (SharePointResource, SharePointConfig, {
        "access_token": "t"
    }),
    "slack": (SlackResource, SlackConfig, {
        "token": "x"
    }),
    "trello": (TrelloResource, TrelloConfig, {
        "api_key": "k",
        "api_token": "t"
    }),
}


def build_arg_error(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    resource_cls, config_cls, kwargs = ARG_ERROR_RESOURCES[mount["backend"]]
    return resource_cls(config_cls(**kwargs)), _noop


BUILDERS = {
    "ram": build_ram,
    "disk": build_disk,
    "redis": build_redis,
    "s3": build_s3,
    "aliyun": build_s3,
    "backblaze": build_s3,
    "ceph": build_s3,
    "digitalocean": build_s3,
    "gcs": build_s3,
    "minio": build_s3,
    "oci": build_s3,
    "qingstor": build_s3,
    "r2": build_s3,
    "scaleway": build_s3,
    "seaweedfs": build_s3,
    "supabase": build_s3,
    "tencent": build_s3,
    "wasabi": build_s3,
    "gridfs": build_gridfs,
    "databricks_volume": build_databricks_volume,
    "onedrive": build_onedrive,
    "sharepoint": build_sharepoint,
    "mem0": build_mem0,
    "postgres": build_postgres,
    "mongodb": build_mongodb,
    "chroma": build_chroma,
    "qdrant": build_qdrant,
    "lancedb": build_lancedb,
    "notion": build_notion,
    "ssh": build_ssh,
    "nextcloud": build_nextcloud,
    "gdrive": build_gdrive,
    "gdocs": build_gdocs,
    "gsheets": build_gsheets,
    "gslides": build_gslides,
    "gcal": build_gcal,
    "gmail": build_gmail,
    "email": build_email,
    "hf": build_hf,
    "hf_models": build_hf_hub,
    "hf_datasets": build_hf_hub,
    "hf_spaces": build_hf_hub,
    "box": build_box,
    "dropbox": build_dropbox,
    "github": build_github,
    "slack": build_slack,
    "trello": build_trello,
    "discord": build_discord,
    "linear": build_linear,
    "langfuse": build_langfuse,
    "jaeger": build_jaeger,
    "dify": build_dify,
    "arg_error": build_arg_error,
    # The mounts are plain RAM; HttpService is what makes this target special.
    "http_fixture": build_ram,
}


async def make_service(target: dict, run_id: str) -> "Service | None":
    if target.get("service") == "s3":
        return S3Service(run_id)
    if target.get("service") == "gridfs":
        return GridFSService(run_id)
    if target.get("service") == "databricks":
        return await DatabricksVolumeService.create(run_id)
    if target.get("service") == "onedrive":
        return await OneDriveService.create(run_id, target)
    if target.get("service") == "sharepoint":
        return await SharePointService.create(run_id, target)
    if target.get("service") == "mem0":
        return await Mem0Service.create()
    if target.get("service") == "postgres":
        return await PostgresService.create()
    if target.get("service") == "mongodb":
        return await MongoDBService.create()
    if target.get("service") == "chroma":
        return await ChromaService.create()
    if target.get("service") == "qdrant":
        return await QdrantService.create(target)
    if target.get("service") == "lancedb":
        return await LanceDBService.create(target)
    if target.get("service") == "notion":
        return await NotionService.create(run_id)
    if target.get("service") == "ssh":
        return await SSHService.create(run_id, target)
    if target.get("service") == "nextcloud":
        return await NextcloudService.create(run_id, target)
    if target.get("service") == "gws":
        return await GwsService.create(run_id, target)
    if target.get("service") == "email":
        return await EmailService.create(run_id, target)
    if target.get("service") == "hf":
        return await HfService.create(run_id)
    if target.get("service") == "hf-hub":
        return await HfHubService.create(run_id)
    if target.get("service") == "box":
        return await BoxService.create(run_id, target)
    if target.get("service") == "dropbox":
        return await DropboxService.create(run_id)
    if target.get("service") == "github":
        github = await GitHubService.create()
        # The write battery runs once per host against one shared fake, so
        # it starts from the seed rather than from the other host's writes.
        if "gh" in (target.get("clis") or []):
            await github.reset()
        return github
    if target.get("service") == "slack":
        return await SlackService.create(run_id)
    if target.get("service") == "trello":
        return await TrelloService.create()
    if target.get("service") == "discord":
        return await DiscordService.create()
    if target.get("service") == "linear":
        return await LinearService.create()
    if target.get("service") == "dify":
        return await DifyService.create(target)
    if target.get("service") == "langfuse":
        return await LangfuseService.create()
    if target.get("service") == "jaeger":
        return await JaegerService.create()
    if target.get("service") == "http":
        return await HttpService.create()
    return None


async def build_mounts(
    target: dict, run_id: str, service: "Service | None"
) -> tuple[dict[str, object], list[Callable[[], Awaitable[None]]]]:
    mounts: dict[str, object] = {}
    cleanups: list[Callable[[], Awaitable[None]]] = []
    built: dict[str, object] = {}
    for mount in target["mounts"]:
        alias_of = mount.get("alias_of")
        if alias_of is not None:
            # Two prefixes over one store: the shape that made cross-mount
            # mv copy an object onto itself and then unlink the source.
            # Reusing the built resource is the only way to express it,
            # since every builder otherwise allocates fresh storage.
            resource = built[alias_of]
            cleanup = _noop
        else:
            builder = BUILDERS[mount["resource"]]
            # A builder is async only when its resource needs I/O to come
            # up — github fetches the repo tree. Awaiting whatever the
            # table returns keeps the other forty builders plain.
            pair = builder(mount, run_id, service)
            if inspect.isawaitable(pair):
                pair = await pair
            resource, cleanup = pair
        built[mount["path"]] = resource
        mode = (MountMode.READ if mount.get("mode") == "read" else
                MountMode.EXEC if mount.get("mode") == "exec" else None)
        # A mount states infrastructure only: what it is, where it is,
        # how it is served. Its permissions live in the profile, under
        # `profiles.<name>.mounts.<prefix>`.
        if mode is not None:
            mounts[mount["path"]] = (resource, mode)
        else:
            mounts[mount["path"]] = resource
        cleanups.append(cleanup)
    return mounts, cleanups


def cli_install(service: "Service | None",
                cli_name: str) -> tuple[CLISpec, dict[str, object] | None]:
    """The spec and config to install one CLI under its head word.

    Every CLI here so far talks to an API, so its mock service hands
    over both the tree and the credentials pointing at itself. `git` is
    the first with neither: it reads a repository out of a mount, which
    is what makes it installable from a bare name, so it resolves
    through the registry the YAML ``clis:`` section uses and installs
    with no config at all.

    Args:
        service (Service | None): the target's mock service, None for a
            target that needs none.
        cli_name (str): the head word the target declared.
    """
    if service is None:
        return cli_spec_for(cli_name), None
    # Widen the assert when another service grows a CLI.
    assert isinstance(
        service, (DiscordService, EmailService, GitHubService, GwsService,
                  HfHubService, LinearService, NotionService, SlackService))
    return service.cli_installs()[cli_name]


async def mutate_write(shadow_ws: Workspace, path: str,
                       content: bytes) -> None:
    await shadow_ws.fs.write(path, content)


async def teardown_target(
    workspaces: list[Workspace],
    cleanups: list[Callable[[], Awaitable[None]]],
    service: "Service | None",
) -> None:
    for ws in workspaces:
        await ws.close()
    for cleanup in cleanups:
        await cleanup()
    if service is not None:
        await service.teardown()


def _redis_console(url: str, prefix: str, job_id: int) -> JobConsole:
    """One job's console on its own Redis stream.

    The nonce beside the id matters because battery cases reap jobs and
    ids restart at 1; a reused stream would replay the previous case's
    chunks, ending chunk included.

    Args:
        url (str): Redis connection URL.
        prefix (str): this run's key namespace.
        job_id (int): the job the console is being built for.
    """
    key_prefix = f"{prefix}{uuid.uuid4().hex[:8]}-{job_id}:"
    # Battery keys must not accumulate in the shared redis db.
    return JobConsole(store=RedisConsoleStore(
        url=url, key_prefix=key_prefix, ttl_seconds=3600))


def console_factory(target: dict, run_id: str) -> ConsoleFactory | None:
    """Build the target's console factory, or None for in-memory.

    A target opts in with ``"console": {"type": "redis"}``; the stream
    keys ride REDIS_URL under a per-run namespace.

    Args:
        target (dict): the target manifest entry.
        run_id (str): this open's unique id.
    """
    block = target.get("console")
    if block is None:
        return None
    url = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
    return functools.partial(_redis_console, url,
                             f"mirage-integ-console-{run_id}:")


async def open_target(
    target: dict,
    consistency: ConsistencyPolicy | None = None
) -> tuple[Workspace, Callable[[], Awaitable[None]]]:
    run_id = uuid.uuid4().hex[:8]
    service = await make_service(target, run_id)
    mounts, cleanups = await build_mounts(target, run_id, service)
    env_block = None
    if target.get("secrets") is not None:
        env_block, secrets_cleanup = build_secrets_env(target["secrets"])
        cleanups.append(secrets_cleanup)
    agent_id = target.get("agentId")
    factory = console_factory(target, run_id)
    # The target's profiles, and which one shapes a session that names
    # none. A profile is the whole permission document, so this is every
    # permission the target states; the models are the ones the YAML
    # door validates with.
    profiles = scripted_profiles(target.get("profiles") or None)
    default_profile = target.get("profile")
    if consistency is not None:
        ws = Workspace(mounts,
                       mode=MountMode.WRITE,
                       consistency=consistency,
                       agent_id=agent_id,
                       console_factory=factory,
                       profiles=profiles,
                       profile=default_profile,
                       env=env_block)
    else:
        ws = Workspace(mounts,
                       mode=MountMode.WRITE,
                       agent_id=agent_id,
                       console_factory=factory,
                       profiles=profiles,
                       profile=default_profile,
                       env=env_block)
    for cli_name in target.get("clis", []):
        spec, config = cli_install(service, cli_name)
        ws.register_cli(cli_name, spec, config)
    # A target's declared environment. A CLI whose spec reads a variable
    # (ntn's --notion-version off NOTION_API_VERSION) behaves differently
    # with and without it, so the conformance runner passes the same map
    # to the real binary and the comparison stays like for like.
    # Through the setter, not into the mapping: `ws.env` is a read-only
    # projection of the variable records, and a target's declared
    # environment is exported by definition -- a CLI reads it as a
    # process environment, which carries exported names only. Only when
    # declared: the setter rebuilds the var table from the projection,
    # which would drop a secrets target's managed pointers and preset
    # attributes.
    if target.get("env"):
        ws.env = {**ws.env, **target["env"]}
    return ws, functools.partial(teardown_target, [ws], cleanups, service)


async def open_consistency(
    target: dict, consistency: ConsistencyPolicy
) -> tuple[
        Workspace,
        Callable[[str, bytes], Awaitable[None]],
        Callable[[], Awaitable[None]],
]:
    run_id = uuid.uuid4().hex[:8]
    service = await make_service(target, run_id)
    read_mounts, read_cleanups = await build_mounts(target, run_id, service)
    shadow_mounts, shadow_cleanups = await build_mounts(
        target, run_id, service)
    read_ws = Workspace(read_mounts,
                        mode=MountMode.WRITE,
                        consistency=consistency)
    shadow_ws = Workspace(shadow_mounts, mode=MountMode.WRITE)
    # Same rule as open_target: a target's declared environment reaches
    # every workspace a case can run against, or a consistency scenario
    # would silently run under a different one.
    read_ws.env = {**read_ws.env, **target.get("env", {})}
    shadow_ws.env = {**shadow_ws.env, **target.get("env", {})}
    return (
        read_ws,
        functools.partial(mutate_write, shadow_ws),
        functools.partial(teardown_target, [read_ws, shadow_ws],
                          [*read_cleanups, *shadow_cleanups], service),
    )


def scripted_profiles(profiles: dict | None) -> dict | None:
    """Wrap a profile's inline policy source the way the config door does.

    A target is JSON, so it carries a profile's policy as source rather
    than as the path a YAML config would name. Loading is the config
    layer's job everywhere else, so the battery does that one step here
    and hands the workspace what code would pass.

    Args:
        profiles (dict | None): the target's profiles as written.
    """
    if not profiles:
        return profiles
    out: dict = {}
    for name, doc in profiles.items():
        policy = doc.get("policy") if isinstance(doc, dict) else None
        script = policy.get("script") if isinstance(policy, dict) else None
        if isinstance(policy, dict) and isinstance(script, dict):
            # Only the program is loaded; the block around it (its
            # runtime) is the document's and stays as written.
            doc = {
                **doc, "policy": {
                    **policy, "script":
                    ScriptSource(script["source"],
                                 language=script.get("language", "python"))
                }
            }
        out[name] = doc
    return out
