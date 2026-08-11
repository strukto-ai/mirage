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
import imaplib
import importlib.util
import inspect
import json
import logging
import os
import shutil
import sys
import tempfile
import uuid
from collections.abc import Awaitable, Callable
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import parsedate_to_datetime
from pathlib import Path
from types import ModuleType

import aiohttp
import asyncpg
import boto3
import chromadb
import lancedb
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
from mirage.core.sharepoint import _resolver as sharepoint_resolver
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
from mirage.resource.gcs import GCSConfig, GCSResource
from mirage.resource.gdocs.config import GDocsConfig
from mirage.resource.gdocs.gdocs import GDocsResource
from mirage.resource.gdrive.config import GoogleDriveConfig
from mirage.resource.gdrive.gdrive import GoogleDriveResource
from mirage.resource.github import GitHubConfig, GitHubResource
from mirage.resource.github_ci.config import GitHubCIConfig
from mirage.resource.github_ci.github_ci import GitHubCIResource
from mirage.resource.gmail.config import GmailConfig
from mirage.resource.gmail.gmail import GmailResource
from mirage.resource.gridfs import GridFSConfig, GridFSResource
from mirage.resource.gsheets.config import GSheetsConfig
from mirage.resource.gsheets.gsheets import GSheetsResource
from mirage.resource.gslides.config import GSlidesConfig
from mirage.resource.gslides.gslides import GSlidesResource
from mirage.resource.hf_buckets import HfBucketsConfig, HfBucketsResource
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
from mirage.types import ConsistencyPolicy

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
EMAIL_IMAP_PORT = int(os.environ.get("EMAIL_IMAP_PORT", "3143"))
EMAIL_SMTP_PORT = int(os.environ.get("EMAIL_SMTP_PORT", "3025"))
EMAIL_API_PORT = int(os.environ.get("EMAIL_API_PORT", "8080"))
EMAIL_USERNAME = "integ@example.com"
EMAIL_PASSWORD = "secret"
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

    def __init__(self, run_id: str, module: ModuleType, store: object,
                 runner: object, base: str) -> None:
        self.run_id = run_id
        self.module = module
        self.store = store
        self.runner = runner
        self.base = base

    @classmethod
    async def create(cls, run_id: str) -> "DatabricksVolumeService":
        module = _load_databricks_server()
        store, runner, base = await module.start_fake_databricks()
        return cls(run_id, module, store, runner, base)

    def resource(self, mount: dict) -> DatabricksVolumeResource:
        volume = f"mirage-integ-{self.run_id}-{mount['volume']}"
        config = DatabricksVolumeConfig(catalog="main",
                                        schema="default",
                                        volume=volume,
                                        root_path=mount.get("prefix") or "/")
        self.store.make_dir(configured_root(config))
        client = self.module.HttpFilesClient(self.base, "integ-token")
        return DatabricksVolumeResource(config, client=client)

    async def teardown(self) -> None:
        await self.runner.cleanup()


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
        Path(__file__).resolve().parents[2] / "server" / "onedrive_server.py")


def _load_hf_server() -> ModuleType:
    return _load_module(
        Path(__file__).resolve().parents[2] / "server" / "hf_server.py")


def _load_dropbox_server() -> ModuleType:
    return _load_module(
        Path(__file__).resolve().parents[2] / "server" / "dropbox_server.py")


def _load_ssh_server() -> ModuleType:
    return _load_module(
        Path(__file__).resolve().parents[2] / "server" / "ssh_server.py")


def _load_box_server() -> ModuleType:
    return _load_module(
        Path(__file__).resolve().parents[2] / "server" / "box_server.py")


def _load_dify_server() -> ModuleType:
    return _load_module(
        Path(__file__).resolve().parents[2] / "server" / "dify_server.py")


def _load_databricks_server() -> ModuleType:
    return _load_module(
        Path(__file__).resolve().parents[2] / "server" /
        "databricks_server.py")


def _load_discord_server() -> ModuleType:
    return _load_module(
        Path(__file__).resolve().parents[2] / "server" / "discord_server.py")


def _load_linear_server() -> ModuleType:
    return _load_module(
        Path(__file__).resolve().parents[2] / "server" / "linear_server.py")


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

    The server is external (integ/server/gws_server.ts) and shared across runs;
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
        url = os.environ["GWS_URL"].rstrip("/")
        folder_ids: dict[str, str] = {}
        drive_ids: dict[str, str] = {}
        # Native mounts (gdocs/gsheets/gslides) render the modified date
        # into filenames, so those targets pin the server clock.
        epoch = target.get("epoch")
        reset_body = {"epoch": epoch} if epoch else {}
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
            apps = target.get("apps")
            if apps:
                manifest = Path(__file__).resolve(
                ).parents[2] / "fixtures" / f"{apps}.json"
                await cls._seed_apps(session, url,
                                     json.loads(manifest.read_text()))
            mail = target.get("mail")
            if mail:
                manifest = Path(__file__).resolve(
                ).parents[2] / "fixtures" / f"{mail}.json"
                await cls._seed_mail(session, url,
                                     json.loads(manifest.read_text()))
        return cls(url, folder_ids, target.get("cli_scope"))

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
    """Points the email mount at a GreenMail IMAP+SMTP server.

    The server is external (a greenmail/standalone container) and shared
    across runs; its REST API /api/service/reset purges every mailbox.
    Seeding appends RFC822 payloads over IMAP so folder UIDs are the append
    order (1, 2, ...) and date dirs come from the manifest Date headers.
    """

    def __init__(self, host: str) -> None:
        self.host = host

    @classmethod
    async def create(cls, run_id: str, target: dict) -> "EmailService":
        host = os.environ["EMAIL_HOST"]
        api = f"http://{host}:{EMAIL_API_PORT}/api/service/reset"
        async with aiohttp.ClientSession() as session:
            async with session.post(api) as resp:
                resp.raise_for_status()
        mail = target.get("mail")
        if mail:
            manifest = Path(
                __file__).resolve().parents[2] / "fixtures" / f"{mail}.json"
            cls._seed_imap(host, json.loads(manifest.read_text()))
        return cls(host)

    @staticmethod
    def _seed_imap(host: str, entries: list[dict]) -> None:
        # Sync imaplib is fine here: this is test scaffolding running
        # before the workspace opens, not backend code.
        imap = imaplib.IMAP4(host, EMAIL_IMAP_PORT)
        imap.login(EMAIL_USERNAME, EMAIL_PASSWORD)
        known = {"INBOX"}
        for entry in entries:
            folder = entry["folder"]
            if folder not in known:
                imap.create(folder)
                known.add(folder)
            flags = "(\\Seen)" if entry.get("seen") else None
            date = imaplib.Time2Internaldate(
                parsedate_to_datetime(entry["date"]))
            imap.append(folder, flags, date, manifest_mime(entry).as_bytes())
        imap.logout()

    def resource(self, mount: dict) -> EmailResource:
        return EmailResource(
            EmailConfig(imap_host=self.host,
                        imap_port=EMAIL_IMAP_PORT,
                        smtp_host=self.host,
                        smtp_port=EMAIL_SMTP_PORT,
                        username=EMAIL_USERNAME,
                        password=EMAIL_PASSWORD,
                        use_ssl=False))

    def cli_installs(self) -> dict[str, tuple[CLISpec, dict[str, object]]]:
        return {
            "himalaya": (cli_spec_for("himalaya"), {
                "imap_host": self.host,
                "imap_port": EMAIL_IMAP_PORT,
                "smtp_host": self.host,
                "smtp_port": EMAIL_SMTP_PORT,
                "username": EMAIL_USERNAME,
                "password": EMAIL_PASSWORD,
                "use_ssl": False,
            }),
        }

    async def teardown(self) -> None:
        return None


class OneDriveService:

    def __init__(self, base: str, runner) -> None:
        self.base = base
        self.runner = runner

    @classmethod
    async def create(cls) -> "OneDriveService":
        module = _load_onedrive_server()
        state, _server, runner = await module.start_fake_graph()
        return cls(state.base, runner)

    def resource(self, mount: dict) -> OneDriveResource:
        return OneDriveResource(
            OneDriveConfig(access_token="integ-token",
                           graph_base_url=self.base,
                           key_prefix=mount.get("prefix")))

    async def teardown(self) -> None:
        await self.runner.cleanup()


class Mem0Service:

    def __init__(self, endpoint: str,
                 process: asyncio.subprocess.Process) -> None:
        self.endpoint = endpoint
        self.process = process

    @classmethod
    async def create(cls) -> "Mem0Service":
        script = (Path(__file__).resolve().parents[2] / "server" /
                  "mem0_server.py")
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            str(script),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        assert process.stdout is not None
        endpoint = (await process.stdout.readline()).decode().strip()
        if not endpoint:
            assert process.stderr is not None
            detail = (await process.stderr.read()).decode().strip()
            raise RuntimeError(f"mem0 fake failed to start: {detail}")
        return cls(endpoint, process)

    def resource(self, mount: dict) -> Mem0Resource:
        return Mem0Resource(
            Mem0Config(api_key="integ-key",
                       host=self.endpoint,
                       user_id="integ-user",
                       default_page_size=2))

    async def teardown(self) -> None:
        if self.process.returncode is None:
            self.process.terminate()
            await self.process.wait()


class HttpService:
    """The fixture web server curl and wget fetch from.

    Exported through ``HTTP_ENDPOINT`` rather than a mount, because the cases
    name it as a URL in the command text (the ``{http}`` token) instead of a
    path. Owning the process here means ``--facet http`` needs no CI setup.
    """

    def __init__(self, endpoint: str,
                 process: asyncio.subprocess.Process) -> None:
        self.endpoint = endpoint
        self.process = process

    @classmethod
    async def create(cls) -> "HttpService":
        script = (Path(__file__).resolve().parents[2] / "server" /
                  "http_server.py")
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            str(script),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        assert process.stdout is not None
        line = (await process.stdout.readline()).decode().strip()
        if not line.startswith("HTTP_ENDPOINT="):
            assert process.stderr is not None
            detail = (await process.stderr.read()).decode().strip()
            raise RuntimeError(f"http fixture failed to start: {detail}")
        endpoint = line.split("=", 1)[1]
        os.environ["HTTP_ENDPOINT"] = endpoint
        return cls(endpoint, process)

    async def teardown(self) -> None:
        os.environ.pop("HTTP_ENDPOINT", None)
        if self.process.returncode is None:
            self.process.terminate()
            await self.process.wait()


class DropboxService:
    """Per-account fake Dropbox servers.

    Mounts sharing a ``bucket`` share one fake account (the -root target
    mounts three root_path subfolders of a single account, mirroring
    s3-prefix's shared bucket); distinct buckets get isolated accounts.
    Fixtures seed through the workspace like every writable backend.
    """

    def __init__(self) -> None:
        self.accounts: dict[str, object] = {}
        self.runners: list = []

    @classmethod
    async def create(cls, target: dict) -> "DropboxService":
        service = cls()
        module = _load_dropbox_server()
        for mount in target["mounts"]:
            account = mount.get("bucket") or mount["path"]
            if account not in service.accounts:
                fake, runner = await module.start_fake_dropbox()
                service.accounts[account] = fake
                service.runners.append(runner)
        return service

    def resource(self, mount: dict) -> DropboxResource:
        account = mount.get("bucket") or mount["path"]
        fake = self.accounts[account]
        return DropboxResource(
            # The fake supports full-text search_v2, so exercise grep/rg
            # narrowing in the battery.
            DropboxConfig(client_id="integ-client",
                          client_secret="integ-secret",
                          refresh_token="integ-refresh",
                          endpoint=fake.endpoint,
                          content_search=True,
                          root_path=mount.get("root") or "/"))

    async def teardown(self) -> None:
        for runner in self.runners:
            await runner.cleanup()


class HfService:

    def __init__(self, run_id: str, runner, endpoint: str) -> None:
        self.run_id = run_id
        self.runner = runner
        self.endpoint = endpoint

    @classmethod
    async def create(cls, run_id: str) -> "HfService":
        module = _load_hf_server()
        _hub, server, runner = await module.start_fake_hub()
        return cls(run_id, runner, server.endpoint)

    def resource(self, mount: dict) -> HfBucketsResource:
        # Buckets auto-create on first touch in the fake, so a per-run
        # bucket name is enough isolation.
        return HfBucketsResource(
            HfBucketsConfig(
                bucket=f"integ/{self.run_id}-{mount['bucket']}",
                token="integ-token",
                endpoint=self.endpoint,
                key_prefix=mount.get("prefix"),
            ))

    async def teardown(self) -> None:
        await self.runner.cleanup()


class BoxService:

    def __init__(self, run_id: str, state, runner, endpoint: str) -> None:
        self.run_id = run_id
        self.state = state
        self.runner = runner
        self.endpoint = endpoint

    @classmethod
    async def create(cls, run_id: str) -> "BoxService":
        module = _load_box_server()
        state, _server, runner = await module.start_fake_box()
        return cls(run_id, state, runner, state.base)

    def resource(self, mount: dict) -> BoxResource:
        # Box is read-only through the workspace, so the harness tee-seeding
        # can't run; each mount gets its own root folder seeded in-process
        # and mounted by id (mirrors how a real Box app scopes to a folder).
        folder = self.state.add_folder("0", mount["folder"])
        seed = mount.get("seed")
        if seed:
            base = Path(__file__).resolve().parents[2] / "fixtures" / seed
            for src in sorted(base.rglob("*")):
                if not src.is_file():
                    continue
                rel = src.relative_to(base).as_posix()
                self.state.seed_path(f"{mount['folder']}/{rel}",
                                     src.read_bytes())
        if seed == "files/v1":
            # A weblink beside the fixture: sizeless and content-free, so
            # listings must hide it and a direct stat must ENOENT.
            self.state.add_web_link(folder["id"], "homepage",
                                    "https://example.com/")
        return BoxResource(
            BoxConfig(
                access_token="integ-box-token",
                endpoint=self.endpoint,
                root_folder_id=folder["id"],
                # The fake supports name+content search, so exercise grep/rg
                # push-down narrowing in the battery.
                content_search=True,
            ))

    async def teardown(self) -> None:
        await self.runner.cleanup()


class SlackService:
    """Points slack mounts at the shared fake Slack Web API server.

    The server (integ/server/slack.ts) is external, Prisma-backed, and shared
    across both hosts; /reset re-seeds it to the fixture. The mount uses a
    user token (xoxp-) so the grep/rg search push-down runs against the fake's
    search.messages / search.files endpoints.

    Args:
        url (str): SLACK_URL origin (methods live under /api).
    """

    def __init__(self, url: str) -> None:
        self.url = url

    @classmethod
    async def create(cls) -> "SlackService":
        url = os.environ["SLACK_URL"].rstrip("/")
        async with aiohttp.ClientSession() as session:
            async with session.post(f"{url}/reset") as resp:
                resp.raise_for_status()
        return cls(url)

    def resource(self, mount: dict) -> SlackResource:
        return SlackResource(
            SlackConfig(token="xoxb-integ",
                        search_token="xoxp-integ-search",
                        base_url=f"{self.url}/api"))

    def cli_installs(self) -> dict[str, tuple[CLISpec, dict[str, object]]]:
        return {
            "slack": (cli_spec_for("slack"), {
                "token": "xoxb-integ",
                "search_token": "xoxp-integ-search",
                "base_url": f"{self.url}/api",
            }),
        }

    async def teardown(self) -> None:
        return None


class GitHubService:
    """Points github mounts at the fake api.github.com server.

    The server (integ/server/github_server.py) runs out of process on
    GITHUB_URL, mirroring the fake Slack and Google Workspace servers and
    shared with the typescript host. It used to be out of process by
    necessity — GitHubResource fetched the repo tree with a blocking
    urlopen from its constructor, which would starve an aiohttp fake on
    the runner's loop. That constraint is gone now that the fetch is
    awaited in `GitHubResource.build`; sharing one fake across both hosts
    is why it stays external.

    Args:
        url (str): GITHUB_URL origin the fake is listening on.
    """

    def __init__(self, url: str) -> None:
        self.url = url

    @classmethod
    async def create(cls) -> "GitHubService":
        return cls(os.environ["GITHUB_URL"].rstrip("/"))

    async def resource(self, mount: dict) -> GitHubResource:
        owner, _, repo = mount["repo"].partition("/")
        return await GitHubResource.build(
            GitHubConfig(token="ghp-integ",
                         owner=owner,
                         repo=repo,
                         base_url=self.url))

    async def teardown(self) -> None:
        return None


class GitHubCIService:
    """Points github_ci mounts at the fake api.github.com server.

    Reuses the external github_server.py process on GITHUB_URL, which also
    serves the fixed Actions dataset (workflows/runs/jobs/artifacts).

    Args:
        url (str): GITHUB_URL origin the fake is listening on.
    """

    def __init__(self, url: str) -> None:
        self.url = url

    @classmethod
    async def create(cls) -> "GitHubCIService":
        return cls(os.environ["GITHUB_URL"].rstrip("/"))

    def resource(self, mount: dict) -> GitHubCIResource:
        owner, _, repo = mount["repo"].partition("/")
        return GitHubCIResource(
            GitHubCIConfig(token="ghp-integ",
                           owner=owner,
                           repo=repo,
                           base_url=self.url))

    async def teardown(self) -> None:
        return None


class DifyService:

    def __init__(self, runner, base: str, dataset: str) -> None:
        self.runner = runner
        self.base = base
        self.dataset = dataset

    @classmethod
    async def create(cls, target: dict) -> "DifyService":
        module = _load_dify_server()
        state, _server, runner = await module.start_fake_dify()
        return cls(runner, state.base, target.get("dataset", "kb-7f3a"))

    def resource(self, mount: dict) -> DifyResource:
        return DifyResource(
            DifyConfig(api_key="integ-key",
                       base_url=self.base,
                       dataset_id=self.dataset))

    async def teardown(self) -> None:
        await self.runner.cleanup()


class TrelloService:
    """Points trello mounts at the shared fake Trello REST API server.

    The server (integ/server/trello.ts) is external, Prisma-backed, and
    shared across both hosts; /reset re-seeds it to the fixture, so the
    write cases see the same state on every run and on either host.

    Args:
        base (str): TRELLO_ENDPOINT origin.
    """

    def __init__(self, base: str) -> None:
        self.base = base

    @classmethod
    async def create(cls) -> "TrelloService":
        base = os.environ["TRELLO_ENDPOINT"].rstrip("/")
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
    """Points discord mounts at the fake discord.com/api server.

    The server (integ/server/discord_server.py) mirrors the documented
    shapes: newest-first message pages, after/limit pagination, and a CDN
    route that serves attachment bytes without the bot token.
    """

    def __init__(self, state, runner, base: str) -> None:
        self.state = state
        self.runner = runner
        self.base = base

    @classmethod
    async def create(cls) -> "DiscordService":
        module = _load_discord_server()
        state, _server, runner = await module.start_fake_discord()
        return cls(state, runner, state.base)

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
        await self.runner.cleanup()


class LinearService:

    def __init__(self, state, runner, base: str) -> None:
        self.state = state
        self.runner = runner
        self.base = base

    @classmethod
    async def create(cls) -> "LinearService":
        module = _load_linear_server()
        state, _server, runner = await module.start_fake_linear()
        return cls(state, runner, state.base)

    def resource(self, mount: dict) -> LinearResource:
        return LinearResource(
            LinearConfig(api_key="integ-key", base_url=self.base))

    def cli_installs(self) -> dict[str, tuple[CLISpec, dict[str, object]]]:
        return {
            "linear": (cli_spec_for("linear"), {
                "api_key": "integ-key",
                "base_url": self.base,
            }),
        }

    async def teardown(self) -> None:
        await self.runner.cleanup()


def _clear_sharepoint_caches() -> None:
    # The resolver's site/drive id caches are module globals; a fresh
    # fake tenant per run must not see ids from the previous one.
    sharepoint_resolver._site_cache.clear()
    sharepoint_resolver._drive_cache.clear()


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

    def __init__(self, base: str, server, runner) -> None:
        self.base = base
        self.server = server
        self.runner = runner

    @classmethod
    async def create(cls) -> "SharePointService":
        module = _load_onedrive_server()
        state, server, runner = await module.start_fake_graph()
        _clear_sharepoint_caches()
        return cls(state.base, server, runner)

    def resource(self, mount: dict) -> SharePointResource:
        graph = self.server.drives.get(mount["drive"])
        if graph is None:
            graph = self.server.add_drive(mount["drive"])
        key_prefix = mount.get("prefix")
        if key_prefix:
            graph._ensure_parents(f"{key_prefix}/placeholder")
        return SharePointResource(
            SharePointConfig(access_token="integ-token",
                             graph_base_url=self.base,
                             site="Main",
                             drive=mount["drive"],
                             key_prefix=key_prefix))

    async def teardown(self) -> None:
        _clear_sharepoint_caches()
        await self.runner.cleanup()


class NotionService:
    """Points notion mounts at the shared fake Notion REST API.

    The server (integ/server/notion_server.ts) is external, Prisma-backed and
    shared across both hosts; /reset re-seeds it to the fixture. The api key
    doubles as the workspace id on that server, the way a real Notion
    integration token scopes you to one workspace, so scenarios that use
    different keys do not see each other's writes.

    Args:
        url (str): NOTION_URL origin (the REST surface lives under /v1).
    """

    def __init__(self, url: str) -> None:
        self.url = url

    @classmethod
    async def create(cls) -> "NotionService":
        url = os.environ["NOTION_URL"].rstrip("/")
        async with aiohttp.ClientSession() as session:
            async with session.post(f"{url}/reset",
                                    json={"workspace": NOTION_TOKEN}) as resp:
                resp.raise_for_status()
        return cls(url)

    def resource(self, mount: dict) -> NotionResource:
        return NotionResource(config=NotionConfig(api_key=NOTION_TOKEN,
                                                  base_url=f"{self.url}/v1"))

    def cli_installs(self) -> dict[str, tuple[CLISpec, dict[str, object]]]:
        return {
            "ntn": (cli_spec_for("ntn"), {
                "api_key": NOTION_TOKEN,
                "base_url": f"{self.url}/v1",
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


class LanceDBService:

    def __init__(self, uri: str) -> None:
        self.uri = uri

    @classmethod
    async def create(cls) -> "LanceDBService":
        uri = tempfile.mkdtemp(prefix="mirage-integ-lancedb-")
        db = lancedb.connect(uri)
        db.create_table("animals", data=LANCEDB_ROWS)
        return cls(uri)

    def resource(self, mount: dict) -> LanceDBResource:
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


class QdrantService:

    def __init__(self, host: str, port: int, collection: str) -> None:
        self.host = host
        self.port = port
        self.collection = collection

    @classmethod
    async def create(cls) -> "QdrantService":
        host = os.environ.get("QDRANT_HOST", "localhost")
        port = int(os.environ.get("QDRANT_PORT", "6333"))
        collection = f"mirage-integ-{uuid.uuid4().hex[:8]}"
        client = AsyncQdrantClient(host=host, port=port)
        try:
            await client.create_collection(
                collection,
                vectors_config=models.VectorParams(
                    size=QDRANT_EMBED_DIM, distance=models.Distance.COSINE))
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
            for field in ("label", "kind"):
                await client.create_payload_index(
                    collection,
                    field_name=field,
                    field_schema=models.PayloadSchemaType.KEYWORD)
            await asyncio.sleep(2)
        finally:
            await client.close()
        return cls(host, port, collection)

    def resource(self, mount: dict) -> QdrantResource:
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
        seed_path = (Path(__file__).resolve().parents[2] / "server" /
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
           | NextcloudService | GwsService | HfService | BoxService
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


def build_github_ci(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, GitHubCIService)
    return service.resource(mount), _noop


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
    "github_ci": (GitHubCIResource, GitHubCIConfig, {
        "token": "t",
        "owner": "o",
        "repo": "r"
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
    "gmail": build_gmail,
    "email": build_email,
    "hf": build_hf,
    "box": build_box,
    "dropbox": build_dropbox,
    "github": build_github,
    "github_ci": build_github_ci,
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
        return await OneDriveService.create()
    if target.get("service") == "sharepoint":
        return await SharePointService.create()
    if target.get("service") == "mem0":
        return await Mem0Service.create()
    if target.get("service") == "postgres":
        return await PostgresService.create()
    if target.get("service") == "mongodb":
        return await MongoDBService.create()
    if target.get("service") == "chroma":
        return await ChromaService.create()
    if target.get("service") == "qdrant":
        return await QdrantService.create()
    if target.get("service") == "lancedb":
        return await LanceDBService.create()
    if target.get("service") == "notion":
        return await NotionService.create()
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
    if target.get("service") == "box":
        return await BoxService.create(run_id)
    if target.get("service") == "dropbox":
        return await DropboxService.create(target)
    if target.get("service") == "github":
        return await GitHubService.create()
    if target.get("service") == "github_ci":
        return await GitHubCIService.create()
    if target.get("service") == "slack":
        return await SlackService.create()
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
        if mount.get("mode") == "read":
            mounts[mount["path"]] = (resource, MountMode.READ)
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
    assert isinstance(service, (DiscordService, EmailService, GwsService,
                                LinearService, NotionService, SlackService))
    return service.cli_installs()[cli_name]


async def mutate_write(shadow_ws: Workspace, path: str,
                       content: bytes) -> None:
    await shadow_ws.ops.write(path, content)


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


async def open_target(
    target: dict,
    consistency: ConsistencyPolicy | None = None
) -> tuple[Workspace, Callable[[], Awaitable[None]]]:
    run_id = uuid.uuid4().hex[:8]
    service = await make_service(target, run_id)
    mounts, cleanups = await build_mounts(target, run_id, service)
    agent_id = target.get("agentId")
    if consistency is not None:
        ws = Workspace(mounts,
                       mode=MountMode.WRITE,
                       consistency=consistency,
                       agent_id=agent_id)
    else:
        ws = Workspace(mounts, mode=MountMode.WRITE, agent_id=agent_id)
    for cli_name in target.get("clis", []):
        spec, config = cli_install(service, cli_name)
        ws.register_cli(cli_name, spec, config)
    # A target's declared environment. A CLI whose spec reads a variable
    # (ntn's --notion-version off NOTION_API_VERSION) behaves differently
    # with and without it, so the conformance runner passes the same map
    # to the real binary and the comparison stays like for like.
    ws.env.update(target.get("env", {}))
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
    read_ws.env.update(target.get("env", {}))
    shadow_ws.env.update(target.get("env", {}))
    return (
        read_ws,
        functools.partial(mutate_write, shadow_ws),
        functools.partial(teardown_target, [read_ws, shadow_ws],
                          [*read_cleanups, *shadow_cleanups], service),
    )
