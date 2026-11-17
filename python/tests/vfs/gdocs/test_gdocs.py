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
from mirage.vfs.gdocs.config import GDocsConfig
from mirage.vfs.gdocs.gdocs import VFS_MD, GDocsVFS
from tests.commands.builtin.jq.conftest import jq_eval
from tests.fixtures.mount_commands import mount_commands


@pytest.fixture
def config():
    return GDocsConfig(
        client_id="test-id",
        client_secret="test-secret",
        refresh_token="test-refresh",
    )


def test_vfs_init(config):
    vfs = GDocsVFS(config=config)
    assert vfs.name == VFSName.GDOCS
    assert vfs.caches_reads is True


def test_vfs_accessor(config):
    vfs = GDocsVFS(config=config)
    assert vfs.accessor is not None
    assert vfs.accessor.config is config
    assert vfs.accessor.token_manager is not None


def test_vfs_commands_registered(config):
    vfs = GDocsVFS(config=config)
    cmds = mount_commands(vfs)
    assert len(cmds) > 15


ALL_TEXT = "[.. | .textRun? // empty | .content] | add"
OLD_FLAT_RECIPE = ".body.content[].paragraph.elements[].textRun.content"


def _tab(
    tab_id: str, title: str, text: str, children: list | None = None
) -> dict:
    tab: dict = {
        "tabProperties": {
            "tabId": tab_id,
            "title": title,
            "index": 0,
            "nestingLevel": 0,
        },
        "documentTab": {
            "body": {
                "content": [
                    {"sectionBreak": {"sectionStyle": {}}},
                    {
                        "paragraph": {
                            "elements": [
                                {
                                    "textRun": {
                                        "content": text + "\n",
                                        "textStyle": {},
                                    }
                                }
                            ]
                        }
                    },
                ]
            },
            "documentStyle": {},
            "namedStyles": {},
        },
    }
    if children:
        tab["childTabs"] = children
    return tab


def _doc() -> dict:
    return {
        "documentId": "doc1",
        "title": "Log",
        "tabs": [
            _tab("t.0", "Tab 1", "first tab"),
            _tab(
                "t.1",
                "Tab 2",
                "second tab",
                [_tab("t.2", "Child", "child tab")],
            ),
        ],
        "revisionId": "rev-3",
    }


def test_vfs_md_includes_buckets_and_structure():
    rendered = VFS_MD.replace("{prefix}", "/gdocs")
    assert "owned/" in rendered
    assert "shared/" in rendered
    assert "stay\n  in `owned/`" in rendered
    assert "`documents.get`" in rendered
    assert ".tabs[].documentTab" in rendered
    assert "childTabs" in rendered


def test_vfs_md_no_longer_promises_a_top_level_body():
    # includeTabsContent=true leaves the singleton fields empty, so the
    # old recipe would return nothing at all on a live document.
    rendered = VFS_MD.replace("{prefix}", "/gdocs")
    assert OLD_FLAT_RECIPE not in rendered
    assert "there is no\n  top-level `.body`" in rendered


def test_vfs_md_recipe_is_the_one_this_test_runs():
    assert ALL_TEXT in VFS_MD


def test_all_text_recipe_reads_every_tab_at_any_depth():
    out = jq_eval(_doc(), ALL_TEXT)
    assert out == ["first tab\nsecond tab\nchild tab\n"]


def test_vfs_md_documents_rm_and_mv_for_a_write_path():
    assert "On a `write` path, `rm` a file to delete it from Drive" in VFS_MD
    assert "`mv` it to a\n  new `<title>`" in VFS_MD
