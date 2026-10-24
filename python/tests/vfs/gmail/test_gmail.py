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

import pytest

from mirage.types import VFSName
from mirage.vfs.gmail.config import GmailConfig
from mirage.vfs.gmail.gmail import VFS_MD, GmailVFS
from tests.fixtures.mount_commands import mount_commands


@pytest.fixture
def config():
    return GmailConfig(
        client_id="test-id",
        client_secret="test-secret",
        refresh_token="test-refresh",
    )


def test_vfs_init(config):
    vfs = GmailVFS(config=config)
    assert vfs.name == VFSName.GMAIL
    assert vfs.caches_reads is True


def test_vfs_accessor(config):
    vfs = GmailVFS(config=config)
    assert vfs.accessor is not None
    assert vfs.accessor.config is config
    assert vfs.accessor.token_manager is not None


def test_vfs_commands_registered(config):
    vfs = GmailVFS(config=config)
    cmds = mount_commands(vfs)
    assert len(cmds) > 15


def test_vfs_md_includes_path_anatomy_and_processed_shape():
    rendered = VFS_MD.replace("{prefix}", "/gmail")
    assert "<label>" in rendered
    assert "INBOX" in rendered
    assert "after:/before:" in rendered
    assert "mirage-processed" in rendered
    assert ".body_text" in rendered
    assert "gws gmail --help" in rendered


def test_vfs_md_documents_file_per_message_layout():
    rendered = VFS_MD.replace("{prefix}", "/gmail")
    assert "<subject>__<message-id>.gmail.json" in rendered
    assert "<subject>__<message-id>/" in rendered
    assert "attachments dir" in rendered
    assert ".attachments[]" in rendered


def test_vfs_md_mentions_grep_skips_binary_attachments():
    rendered = VFS_MD.replace("{prefix}", "/gmail")
    assert "grep" in rendered
    assert "binary" in rendered.lower()
