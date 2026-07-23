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
import functools
import imaplib
import importlib.util
import json
import logging
import os
import shutil
import tempfile
import uuid
from collections.abc import Awaitable, Callable
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import parsedate_to_datetime
from pathlib import Path
from types import ModuleType

import aiohttp
import boto3
from moto.server import ThreadedMotoServer
from pymongo import AsyncMongoClient

from mirage import MountMode, Workspace
from mirage.accessor.onedrive import OneDriveConfig
from mirage.accessor.sharepoint import SharePointConfig
from mirage.core.databricks_volume.path import configured_root
from mirage.core.google import _client as google_client
from mirage.core.sharepoint import _resolver as sharepoint_resolver
from mirage.resource.aliyun import AliyunConfig, AliyunResource
from mirage.resource.backblaze import BackblazeConfig, BackblazeResource
from mirage.resource.box import BoxConfig, BoxResource
from mirage.resource.ceph import CephConfig, CephResource
from mirage.resource.databricks_volume import (DatabricksVolumeConfig,
                                               DatabricksVolumeResource)
from mirage.resource.dify import DifyConfig, DifyResource
from mirage.resource.digitalocean import (DigitalOceanConfig,
                                          DigitalOceanResource)
from mirage.resource.disk import DiskResource
from mirage.resource.dropbox import DropboxConfig, DropboxResource
from mirage.resource.email.config import EmailConfig
from mirage.resource.email.email import EmailResource
from mirage.resource.gcs import GCSConfig, GCSResource
from mirage.resource.gdocs.config import GDocsConfig
from mirage.resource.gdocs.gdocs import GDocsResource
from mirage.resource.gdrive.config import GoogleDriveConfig
from mirage.resource.gdrive.gdrive import GoogleDriveResource
from mirage.resource.gmail.config import GmailConfig
from mirage.resource.gmail.gmail import GmailResource
from mirage.resource.gridfs import GridFSConfig, GridFSResource
from mirage.resource.gsheets.config import GSheetsConfig
from mirage.resource.gsheets.gsheets import GSheetsResource
from mirage.resource.gslides.config import GSlidesConfig
from mirage.resource.gslides.gslides import GSlidesResource
from mirage.resource.hf_buckets import HfBucketsConfig, HfBucketsResource
from mirage.resource.linear import LinearConfig, LinearResource
from mirage.resource.minio import MinIOConfig, MinIOResource
from mirage.resource.nextcloud import NextcloudConfig, NextcloudResource
from mirage.resource.oci import OCIConfig, OCIResource
from mirage.resource.onedrive.onedrive import OneDriveResource
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


def _load_trello_server() -> ModuleType:
    return _load_module(
        Path(__file__).resolve().parents[2] / "server" / "trello_server.py")


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


def _use_fake_google_endpoints(url: str) -> None:
    google_client.TOKEN_URL = f"{url}/token"
    google_client.DRIVE_API_BASE = f"{url}/drive/v3"
    google_client.DRIVE_UPLOAD_BASE = f"{url}/upload/drive/v3"
    google_client.DOCS_API_BASE = f"{url}/v1"
    google_client.SLIDES_API_BASE = f"{url}/v1"
    google_client.SHEETS_API_BASE = f"{url}/v4"
    google_client.GMAIL_API_BASE = f"{url}/gmail/v1"


class GwsService:
    """Points gdrive mounts at the fake Google Workspace server.

    The server is external (integ/server/gws_server.ts) and shared across runs;
    /reset gives each run a clean, deterministic state. Each mount is scoped
    to a per-mount folder via GoogleConfig.folder_id, the s3 key_prefix
    analog, so the three mounts never see each other.
    """

    def __init__(self, url: str, folder_ids: dict[str, str]) -> None:
        self.url = url
        self.folder_ids = folder_ids

    @classmethod
    async def create(cls, run_id: str, target: dict) -> "GwsService":
        url = os.environ["GWS_URL"].rstrip("/")
        _use_fake_google_endpoints(url)
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
        return cls(url, folder_ids)

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
                              folder_id=self.folder_ids[mount["path"]]))

    def gdocs_resource(self) -> GDocsResource:
        return GDocsResource(
            GDocsConfig(client_id="integ", refresh_token="integ"))

    def gsheets_resource(self) -> GSheetsResource:
        return GSheetsResource(
            GSheetsConfig(client_id="integ", refresh_token="integ"))

    def gslides_resource(self) -> GSlidesResource:
        return GSlidesResource(
            GSlidesConfig(client_id="integ", refresh_token="integ"))

    def gmail_resource(self) -> GmailResource:
        return GmailResource(
            GmailConfig(client_id="integ", refresh_token="integ"))

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

    async def teardown(self) -> None:
        return None


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

    def __init__(self, state, runner, base: str) -> None:
        self.state = state
        self.runner = runner
        self.base = base

    @classmethod
    async def create(cls) -> "TrelloService":
        module = _load_trello_server()
        state, _server, runner = await module.start_fake_trello()
        return cls(state, runner, state.base)

    def resource(self, mount: dict) -> TrelloResource:
        return TrelloResource(
            TrelloConfig(api_key="integ-key",
                         api_token="integ-token",
                         base_url=self.base))

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
        graph = self.server.drives.get(mount["drive"])
        if graph is None:
            graph = self.server.add_drive(mount["drive"])
        key_prefix = mount.get("prefix")
        if key_prefix:
            graph._ensure_parents(f"{key_prefix}/placeholder")
        return SharePointResource(
            SharePointConfig(access_token="integ-token",
                             site="Main",
                             drive=mount["drive"],
                             key_prefix=key_prefix))

    async def teardown(self) -> None:
        _clear_sharepoint_caches()
        await self.runner.cleanup()


Service = (S3Service | OneDriveService | SharePointService | SSHService
           | NextcloudService | GwsService | HfService | BoxService
           | DropboxService | GridFSService | SlackService | TrelloService
           | LinearService | DifyService | DatabricksVolumeService)


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


def build_linear(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, LinearService)
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


def build_slack(
        mount: dict, run_id: str, service: Service | None
) -> tuple[object, Callable[[], Awaitable[None]]]:
    assert isinstance(service, SlackService)
    return service.resource(mount), _noop


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
    "slack": build_slack,
    "trello": build_trello,
    "linear": build_linear,
    "dify": build_dify,
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
    if target.get("service") == "slack":
        return await SlackService.create()
    if target.get("service") == "trello":
        return await TrelloService.create()
    if target.get("service") == "linear":
        return await LinearService.create()
    if target.get("service") == "dify":
        return await DifyService.create(target)
    return None


def build_mounts(
    target: dict, run_id: str, service: "Service | None"
) -> tuple[dict[str, object], list[Callable[[], Awaitable[None]]]]:
    mounts: dict[str, object] = {}
    cleanups: list[Callable[[], Awaitable[None]]] = []
    for mount in target["mounts"]:
        builder = BUILDERS[mount["resource"]]
        resource, cleanup = builder(mount, run_id, service)
        if mount.get("mode") == "read":
            mounts[mount["path"]] = (resource, MountMode.READ)
        else:
            mounts[mount["path"]] = resource
        cleanups.append(cleanup)
    return mounts, cleanups


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
    mounts, cleanups = build_mounts(target, run_id, service)
    if consistency is not None:
        ws = Workspace(mounts, mode=MountMode.WRITE, consistency=consistency)
    else:
        ws = Workspace(mounts, mode=MountMode.WRITE)
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
    read_mounts, read_cleanups = build_mounts(target, run_id, service)
    shadow_mounts, shadow_cleanups = build_mounts(target, run_id, service)
    read_ws = Workspace(read_mounts,
                        mode=MountMode.WRITE,
                        consistency=consistency)
    shadow_ws = Workspace(shadow_mounts, mode=MountMode.WRITE)
    return (
        read_ws,
        functools.partial(mutate_write, shadow_ws),
        functools.partial(teardown_target, [read_ws, shadow_ws],
                          [*read_cleanups, *shadow_cleanups], service),
    )
