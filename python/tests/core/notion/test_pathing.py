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

import pytest

from mirage.core.notion.normalize import normalize_page, to_json_bytes
from mirage.core.notion.pathing import page_dirname, split_suffix_id


class TestSplitSuffixId:

    def test_basic(self):
        label, oid = split_suffix_id("my-page__abc123")
        assert label == "my-page"
        assert oid == "abc123"

    def test_with_suffix(self):
        label, oid = split_suffix_id("my-page__abc123.json", suffix=".json")
        assert label == "my-page"
        assert oid == "abc123"

    def test_no_separator_raises(self):
        with pytest.raises(FileNotFoundError):
            split_suffix_id("noid")

    def test_wrong_suffix_raises(self):
        with pytest.raises(FileNotFoundError):
            split_suffix_id("my-page__abc.json", suffix=".md")


class TestPageDirname:

    def test_with_title(self):
        page = {
            "id": "abc-123",
            "properties": {
                "title": {
                    "type": "title",
                    "title": [{
                        "plain_text": "Hello World"
                    }],
                },
            },
        }
        result = page_dirname(page)
        assert result.endswith("__abc-123")
        assert "hello" in result.lower()

    def test_untitled(self):
        page = {"id": "xyz", "properties": {}}
        result = page_dirname(page)
        assert result == "untitled__xyz"


class TestNormalizePage:

    def test_basic(self):
        page = {
            "id": "abc-123",
            "url": "https://notion.so/abc123",
            "created_time": "2026-01-01T00:00:00.000Z",
            "last_edited_time": "2026-04-15T00:00:00.000Z",
            "parent": {
                "type": "workspace",
                "workspace": True
            },
            "archived": False,
            "created_by": {
                "id": "user1"
            },
            "last_edited_by": {
                "id": "user2"
            },
            "properties": {
                "title": {
                    "type": "title",
                    "title": [{
                        "plain_text": "Test"
                    }]
                },
            },
        }
        blocks = [
            {
                "type": "paragraph",
                "paragraph": {
                    "rich_text": [{
                        "plain_text": "Hello",
                        "annotations": {}
                    }]
                }
            },
            {
                "type": "child_page",
                "child_page": {
                    "title": "Sub"
                }
            },
        ]
        result = normalize_page(page, blocks)
        assert result["page_id"] == "abc-123"
        assert result["title"] == "Test"
        assert "Hello" in result["markdown"]
        assert len(result["blocks"]) == 1

    def test_a_row_carries_its_cells(self):
        # A database row's cells are its `properties`, and they are the
        # reason the row exists. Without them `cat` on a row answered with
        # metadata and an empty markdown, and the row's actual data was
        # reachable only through `ntn datasources query`.
        page = {
            "id": "row-1",
            "parent": {
                "type": "data_source_id",
                "data_source_id": "ds-1",
            },
            "properties": {
                "Name": {
                    "id": "title",
                    "type": "title",
                    "title": [{
                        "plain_text": "Write spec"
                    }],
                },
                "Priority": {
                    "id": "pri",
                    "type": "number",
                    "number": 2,
                },
            },
        }
        result = normalize_page(page, [])
        assert result["properties"]["Priority"]["number"] == 2
        assert result["parent_id"] == "ds-1"
        # Kept as Notion's own property objects, not flattened, so the
        # ids and types the schema is written in survive the render.
        assert result["properties"]["Name"]["id"] == "title"

    def test_a_page_without_properties_renders_an_empty_map(self):
        result = normalize_page({"id": "p1"}, [])
        assert result["properties"] == {}

    def test_a_non_object_properties_is_not_forwarded(self):
        result = normalize_page({"id": "p1", "properties": []}, [])
        assert result["properties"] == {}

    def test_to_json_bytes(self):
        data = to_json_bytes({"key": "value"})
        assert isinstance(data, bytes)
        parsed = json.loads(data)
        assert parsed["key"] == "value"
