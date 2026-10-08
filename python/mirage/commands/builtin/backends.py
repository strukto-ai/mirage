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
# ``COMMANDS``), by the class's module path, so a class of the same name
# defined elsewhere is not taken for the builtin. Imported on first mount,
# so a workspace loads only the backends it mounts.
_MODULES: dict[str, str] = {
    "mirage.vfs.airtable.airtable.AirtableVFS": "mirage.commands.builtin.airtable",
    "mirage.vfs.bin.bin.BinViewVFS": "mirage.commands.builtin.bin",
    "mirage.vfs.box.box.BoxVFS": "mirage.commands.builtin.box",
    "mirage.vfs.chroma.chroma.ChromaVFS": "mirage.commands.builtin.chroma",
    "mirage.vfs.databricks_volume.databricks_volume.DatabricksVolumeVFS": (
        "mirage.commands.builtin.databricks_volume"
    ),
    "mirage.vfs.dev.dev.DevVFS": "mirage.commands.builtin.dev",
    "mirage.vfs.dify.dify.DifyVFS": "mirage.commands.builtin.dify",
    "mirage.vfs.discord.discord.DiscordVFS": "mirage.commands.builtin.discord",
    "mirage.vfs.disk.disk.DiskVFS": "mirage.commands.builtin.disk",
    "mirage.vfs.dropbox.dropbox.DropboxVFS": "mirage.commands.builtin.dropbox",
    "mirage.vfs.email.email.EmailVFS": "mirage.commands.builtin.email",
    "mirage.vfs.gcal.gcal.GCalVFS": "mirage.commands.builtin.gcal",
    "mirage.vfs.gdocs.gdocs.GDocsVFS": "mirage.commands.builtin.gdocs",
    "mirage.vfs.gsheets.gsheets.GSheetsVFS": "mirage.commands.builtin.gsheets",
    "mirage.vfs.gslides.gslides.GSlidesVFS": "mirage.commands.builtin.gslides",
    "mirage.vfs.github.github.GitHubVFS": "mirage.commands.builtin.github",
    "mirage.vfs.gmail.gmail.GmailVFS": "mirage.commands.builtin.gmail",
    "mirage.vfs.gdrive.gdrive.GoogleDriveVFS": "mirage.commands.builtin.gdrive",
    "mirage.vfs.gridfs.gridfs.GridFSVFS": "mirage.commands.builtin.gridfs",
    "mirage.vfs.hf_buckets.hf_buckets.HfBucketsVFS": (
        "mirage.commands.builtin.hf_buckets"
    ),
    "mirage.vfs.hf_hub.base.HfHubVFS": "mirage.commands.builtin.hf_hub",
    "mirage.vfs.history.history.HistoryViewVFS": "mirage.commands.builtin.history",
    "mirage.vfs.jaeger.jaeger.JaegerVFS": "mirage.commands.builtin.jaeger",
    "mirage.vfs.lancedb.lancedb.LanceDBVFS": "mirage.commands.builtin.lancedb",
    "mirage.vfs.langfuse.langfuse.LangfuseVFS": "mirage.commands.builtin.langfuse",
    "mirage.vfs.linear.linear.LinearVFS": "mirage.commands.builtin.linear",
    "mirage.vfs.mem0.mem0.Mem0VFS": "mirage.commands.builtin.mem0",
    "mirage.vfs.mongodb.mongodb.MongoDBVFS": "mirage.commands.builtin.mongodb",
    "mirage.vfs.nextcloud.nextcloud.NextcloudVFS": "mirage.commands.builtin.nextcloud",
    "mirage.vfs.notion.notion.NotionVFS": "mirage.commands.builtin.notion",
    "mirage.vfs.onedrive.onedrive.OneDriveVFS": "mirage.commands.builtin.onedrive",
    "mirage.vfs.postgres.postgres.PostgresVFS": "mirage.commands.builtin.postgres",
    "mirage.vfs.qdrant.qdrant.QdrantVFS": "mirage.commands.builtin.qdrant",
    "mirage.vfs.ram.ram.RAMVFS": "mirage.commands.builtin.ram",
    "mirage.vfs.redis.redis.RedisVFS": "mirage.commands.builtin.redis",
    "mirage.vfs.s3.s3.S3VFS": "mirage.commands.builtin.s3",
    "mirage.vfs.ssh.ssh.SSHVFS": "mirage.commands.builtin.ssh",
    "mirage.vfs.sharepoint.sharepoint.SharePointVFS": (
        "mirage.commands.builtin.sharepoint"
    ),
    "mirage.vfs.slack.slack.SlackVFS": "mirage.commands.builtin.slack",
    "mirage.vfs.trello.trello.TrelloVFS": "mirage.commands.builtin.trello",
    "mirage.vfs.wandb.wandb.WandbVFS": "mirage.commands.builtin.wandb",
}


def commands_for(vfs: BaseVFS) -> list[RegisteredCommand]:
    """Every shell command a mount of ``vfs`` serves.

    A builtin's are its command module's, found through the first class
    in its hierarchy that has one; a command registered under that
    class's name is registered under the VFS's own instead, so an
    S3-compatible alias serves S3's commands as itself. Any other VFS
    serves the generic set. Either set loses what the VFS overrides, and
    the commands the VFS was handed come last, so they win.

    Args:
        vfs (BaseVFS): the VFS being mounted.
    """
    found: list[RegisteredCommand] | None = None
    for klass in type(vfs).__mro__:
        module = _MODULES.get(f"{klass.__module__}.{klass.__qualname__}")
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
    kept = [rc for rc in found if rc.name not in vfs.overrides]
    return [*kept, *registered_commands(vfs.commands())]
