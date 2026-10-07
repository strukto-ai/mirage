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

import importlib
from dataclasses import replace

from mirage.commands.builtin.generic_bind import make_generic_commands
from mirage.commands.config import RegisteredCommand, registered_commands
from mirage.vfs.base import BaseVFS

# The module holding each builtin VFS class's shell commands (its
# ``COMMANDS``), by the class's name. Imported on first mount, so a
# workspace loads only the backends it mounts.
_MODULES: dict[str, str] = {
    "AirtableVFS": "mirage.commands.builtin.airtable",
    "BinViewVFS": "mirage.commands.builtin.bin",
    "BoxVFS": "mirage.commands.builtin.box",
    "ChromaVFS": "mirage.commands.builtin.chroma",
    "DatabricksVolumeVFS": "mirage.commands.builtin.databricks_volume",
    "DevVFS": "mirage.commands.builtin.dev",
    "DifyVFS": "mirage.commands.builtin.dify",
    "DiscordVFS": "mirage.commands.builtin.discord",
    "DiskVFS": "mirage.commands.builtin.disk",
    "DropboxVFS": "mirage.commands.builtin.dropbox",
    "EmailVFS": "mirage.commands.builtin.email",
    "GCalVFS": "mirage.commands.builtin.gcal",
    "GDocsVFS": "mirage.commands.builtin.gdocs",
    "GSheetsVFS": "mirage.commands.builtin.gsheets",
    "GSlidesVFS": "mirage.commands.builtin.gslides",
    "GitHubVFS": "mirage.commands.builtin.github",
    "GmailVFS": "mirage.commands.builtin.gmail",
    "GoogleDriveVFS": "mirage.commands.builtin.gdrive",
    "GridFSVFS": "mirage.commands.builtin.gridfs",
    "HfBucketsVFS": "mirage.commands.builtin.hf_buckets",
    "HfHubVFS": "mirage.commands.builtin.hf_hub",
    "HistoryViewVFS": "mirage.commands.builtin.history",
    "JaegerVFS": "mirage.commands.builtin.jaeger",
    "LanceDBVFS": "mirage.commands.builtin.lancedb",
    "LangfuseVFS": "mirage.commands.builtin.langfuse",
    "LinearVFS": "mirage.commands.builtin.linear",
    "Mem0VFS": "mirage.commands.builtin.mem0",
    "MongoDBVFS": "mirage.commands.builtin.mongodb",
    "NextcloudVFS": "mirage.commands.builtin.nextcloud",
    "NotionVFS": "mirage.commands.builtin.notion",
    "OneDriveVFS": "mirage.commands.builtin.onedrive",
    "PostgresVFS": "mirage.commands.builtin.postgres",
    "QdrantVFS": "mirage.commands.builtin.qdrant",
    "RAMVFS": "mirage.commands.builtin.ram",
    "RedisVFS": "mirage.commands.builtin.redis",
    "S3VFS": "mirage.commands.builtin.s3",
    "SSHVFS": "mirage.commands.builtin.ssh",
    "SharePointVFS": "mirage.commands.builtin.sharepoint",
    "SlackVFS": "mirage.commands.builtin.slack",
    "TrelloVFS": "mirage.commands.builtin.trello",
    "WandbVFS": "mirage.commands.builtin.wandb",
}


def mount_commands(vfs: BaseVFS) -> list[RegisteredCommand]:
    """Every shell command a mount of ``vfs`` serves.

    A builtin's are its command module's, found through the first class
    in its hierarchy that has one; a command registered under that
    class's name is registered under the VFS's own instead, so an
    S3-compatible alias serves S3's commands as itself. Any other VFS
    serves the generic set less what it overrides. The commands the VFS
    was handed come last, so they win.

    Args:
        vfs (BaseVFS): the VFS being mounted.
    """
    found: list[RegisteredCommand] | None = None
    for klass in type(vfs).__mro__:
        module = _MODULES.get(klass.__name__)
        if module is None:
            continue
        family = klass.__dict__.get("name", vfs.name)
        found = [
            replace(rc, vfs=vfs.name) if rc.vfs == family else rc
            for rc in registered_commands(
                importlib.import_module(module).COMMANDS
            )
        ]
        break
    if found is None:
        found = registered_commands(
            make_generic_commands(vfs.name, overrides=vfs.overrides)
        )
    return [*found, *registered_commands(vfs.commands())]
