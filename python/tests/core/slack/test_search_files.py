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

import json
from unittest.mock import AsyncMock, patch

import pytest

from mirage.core.slack.formatters import build_query, format_file_grep_results
from mirage.core.slack.scope import SlackScope
from mirage.core.slack.search import search_files
from mirage.resource.slack.config import SlackConfig


@pytest.mark.asyncio
async def test_search_files_calls_correct_endpoint():
    config = SlackConfig(token="xoxb", search_token="xoxp")
    fake_response = {
        "ok": True,
        "files": {
            "matches": []
        },
    }
    with patch("mirage.core.slack.search.slack_get",
               new_callable=AsyncMock,
               return_value=fake_response) as mock:
        await search_files(config, "report")
    args, kwargs = mock.call_args
    assert args[1] == "search.files"
    assert kwargs["params"]["query"] == "report"
    assert kwargs["token"] == "xoxp"


def test_format_file_grep_results_renders_paths():
    raw_payload = {
        "files": {
            "matches": [
                {
                    "id": "F1ABC",
                    "name": "report.pdf",
                    "title": "Q4 Report",
                    "filetype": "pdf",
                    "channels": ["C001"],
                    "timestamp": 1712707200,
                },
            ],
        },
    }
    raw = json.dumps(raw_payload).encode()
    scope = SlackScope(use_native=True,
                       container="channels",
                       channel_name="general",
                       channel_id="C001",
                       target="files")
    lines = format_file_grep_results(raw, scope, "/slack")
    assert len(lines) == 1
    line = lines[0]
    assert "files/" in line
    assert "F1ABC" in line
    assert "[file]" in line
    assert "Q4 Report" in line


def test_build_query_unchanged_for_files():
    scope = SlackScope(use_native=True,
                       container="channels",
                       channel_name="eng",
                       channel_id="C1",
                       target="files")
    assert build_query("foo", scope) == "in:#eng foo"


def test_format_file_grep_results_emits_exact_path():
    raw_payload = {
        "files": {
            "matches": [{
                "id": "F1ABC",
                "name": "report.pdf",
                "title": "Q4 Report",
                "filetype": "pdf",
                "channels": ["C001"],
                "timestamp": 1712707200,
            }],
        },
    }
    raw = json.dumps(raw_payload).encode()
    scope = SlackScope(use_native=True,
                       container="channels",
                       channel_name="general",
                       channel_id="C001",
                       target="files")
    lines = format_file_grep_results(raw, scope, "/slack")
    assert len(lines) == 1
    expected_path = ("/slack/channels/general__C001/2024-04-10/files/"
                     "report__F1ABC.pdf")
    assert lines[0].startswith(expected_path + ":"), lines[0]


def test_format_file_grep_results_skips_when_no_scope_channel():
    raw_payload = {
        "files": {
            "matches": [{
                "id": "F1ABC",
                "name": "report.pdf",
                "title": "Q4 Report",
                "channels": ["C001"],
                "timestamp": 1712707200,
            }],
        },
    }
    raw = json.dumps(raw_payload).encode()
    scope = SlackScope(use_native=True,
                       container="channels",
                       channel_name=None,
                       channel_id=None,
                       target="files")
    lines = format_file_grep_results(raw, scope, "/slack")
    assert lines == []


def test_format_file_grep_results_sanitizes_name():
    raw_payload = {
        "files": {
            "matches": [{
                "id": "F1ABC",
                "name": "Q4 Report (final).pdf",
                "title": "Q4",
                "channels": ["C001"],
                "timestamp": 1712707200,
            }],
        },
    }
    raw = json.dumps(raw_payload).encode()
    scope = SlackScope(
        use_native=True,
        container="channels",
        channel_name="general",
        channel_id="C001",
        target="files",
    )
    lines = format_file_grep_results(raw, scope, "/slack")
    assert len(lines) == 1
    line = lines[0]
    assert "F1ABC" in line
    blob_segment = line.split("/files/")[1].split(":")[0]
    assert " " not in blob_segment
    assert "(" not in blob_segment
    assert ")" not in blob_segment
    assert blob_segment.endswith("__F1ABC.pdf")
