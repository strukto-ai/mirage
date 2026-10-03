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
import logging

import pytest

from mirage.cache.index import IndexEntry
from mirage.core.dropbox.constants import CONTENT_HASH
from mirage.core.dropbox.fingerprint import (
    entry_token,
    result_token,
    token_of,
)


@pytest.mark.parametrize(
    "value, token",
    [("abc", "abc"), ("", None), (None, None), (7, None), (["a"], None)],
    ids=["hash", "empty", "absent", "number", "list"],
)
def test_only_a_non_empty_string_is_a_token(value, token):
    assert token_of(value) == token


def test_an_entry_token_is_the_content_hash_its_row_carries():
    row = IndexEntry(
        id="id:a", name="a", resource_type="file", extra={CONTENT_HASH: "h"}
    )
    bare = IndexEntry(id="id:b", name="b", resource_type="file")
    assert (entry_token(row), entry_token(bare)) == ("h", None)


def test_a_result_header_names_its_content_hash():
    raw = json.dumps(
        {
            "name": "a",
            "server_modified": "2026-01-01T00:00:00Z",
            CONTENT_HASH: "h",
        }
    )
    assert result_token(raw) == "h"


@pytest.mark.parametrize(
    "raw",
    [
        None,
        "",
        "not json",
        json.dumps(["a"]),
        json.dumps({"server_modified": "2026-01-01T00:00:00Z"}),
        json.dumps({CONTENT_HASH: ""}),
    ],
    ids=["absent", "blank", "unparseable", "not-object", "no-hash", "empty"],
)
def test_a_result_header_without_a_content_hash_is_no_token(raw):
    # Never the modified stamp: stat stamps content_hash, so any other kind
    # here would compare unequal forever, or worse, equal by chance.
    assert result_token(raw) is None


@pytest.mark.parametrize(
    "raw", ["not json", json.dumps(["a"])], ids=["unparseable", "not-object"]
)
def test_an_unreadable_result_header_warns(raw, caplog):
    # Real Dropbox always sends a JSON object here, so a reply that isn't
    # explains why every fresh read of the file goes cold.
    with caplog.at_level(logging.WARNING, logger="mirage.core.dropbox"):
        assert result_token(raw) is None
    assert "Dropbox-API-Result" in caplog.text


def test_an_absent_result_header_does_not_warn(caplog):
    with caplog.at_level(logging.WARNING, logger="mirage.core.dropbox"):
        assert result_token(None) is None
    assert caplog.text == ""
