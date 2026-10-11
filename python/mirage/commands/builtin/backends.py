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

from mirage.commands.config import Command, registered_commands
from mirage.vfs.base import BaseVFS

# The module holding each builtin VFS class's shell commands (its
# ``COMMANDS``), by the class's module path, so a class of the same name
# defined elsewhere is not taken for the builtin. Imported on first mount,
# so a workspace loads only the backends it mounts.
_MODULES: dict[str, str] = {
    "mirage.vfs.airtable.airtable.AirtableVFS": "mirage.commands.builtin.airtable",
    "mirage.vfs.chroma.chroma.ChromaVFS": "mirage.commands.builtin.chroma",
    "mirage.vfs.dev.dev.DevVFS": "mirage.commands.builtin.dev",
    "mirage.vfs.dify.dify.DifyVFS": "mirage.commands.builtin.dify",
    "mirage.vfs.discord.discord.DiscordVFS": "mirage.commands.builtin.discord",
    "mirage.vfs.disk.disk.DiskVFS": "mirage.commands.builtin.disk",
    "mirage.vfs.email.email.EmailVFS": "mirage.commands.builtin.email",
    "mirage.vfs.gcal.gcal.GCalVFS": "mirage.commands.builtin.gcal",
    "mirage.vfs.gdocs.gdocs.GDocsVFS": "mirage.commands.builtin.gdocs",
    "mirage.vfs.gsheets.gsheets.GSheetsVFS": "mirage.commands.builtin.gsheets",
    "mirage.vfs.gslides.gslides.GSlidesVFS": "mirage.commands.builtin.gslides",
    "mirage.vfs.github.github.GitHubVFS": "mirage.commands.builtin.github",
    "mirage.vfs.gridfs.gridfs.GridFSVFS": "mirage.commands.builtin.gridfs",
    "mirage.vfs.history.history.HistoryViewVFS": "mirage.commands.builtin.history",
    "mirage.vfs.lancedb.lancedb.LanceDBVFS": "mirage.commands.builtin.lancedb",
    "mirage.vfs.langfuse.langfuse.LangfuseVFS": "mirage.commands.builtin.langfuse",
    "mirage.vfs.mem0.mem0.Mem0VFS": "mirage.commands.builtin.mem0",
    "mirage.vfs.mongodb.mongodb.MongoDBVFS": "mirage.commands.builtin.mongodb",
    "mirage.vfs.postgres.postgres.PostgresVFS": "mirage.commands.builtin.postgres",
    "mirage.vfs.qdrant.qdrant.QdrantVFS": "mirage.commands.builtin.qdrant",
    "mirage.vfs.s3.s3.S3VFS": "mirage.commands.builtin.s3",
    "mirage.vfs.ssh.ssh.SSHVFS": "mirage.commands.builtin.ssh",
    "mirage.vfs.trello.trello.TrelloVFS": "mirage.commands.builtin.trello",
}


def commands_for(vfs: BaseVFS) -> list[Command]:
    """The shell commands a mount of ``vfs`` serves beside the generic set.

    A builtin's are its command module's, found through the first class
    in its hierarchy that has one; a command registered under that
    class's name is registered under the VFS's own instead, so an
    S3-compatible alias serves S3's commands as itself. The commands the
    VFS was handed come last, so they win. A name none of these has falls
    back to the generic command every mount shares.

    Args:
        vfs (BaseVFS): the VFS being mounted.
    """
    found: list[Command] = []
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
    return [*found, *registered_commands(vfs.commands())]
