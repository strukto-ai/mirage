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
from pathlib import Path

from mirage.types import ContentType
from mirage.utils.filetype import (CONTENT_BY_EXTENSION, CONTENT_BY_MIME,
                                   MIME_BY_EXTENSION,
                                   content_type_for_extension,
                                   content_type_for_mime,
                                   content_type_for_path, mime_type_for)

_FIXTURE = (Path(__file__).parents[3] / "integ" / "fixtures" / "filetype" /
            "tables.json")


def test_shared_parity_fixture_pins_every_table():
    # integ/fixtures/filetype/tables.json is the contract: the TypeScript
    # suite (packages/core/src/utils/filetype.test.ts) asserts the same
    # tables, so an edit on one side fails the other until the fixture
    # moves with it.
    tables = json.loads(_FIXTURE.read_text())
    assert {
        k: v.value
        for k, v in CONTENT_BY_EXTENSION.items()
    } == tables["content_by_extension"]
    assert {
        k: v.value
        for k, v in CONTENT_BY_MIME.items()
    } == tables["content_by_mime"]
    assert MIME_BY_EXTENSION == tables["mime_by_extension"]


def test_content_type_for_path_reads_the_extension():
    assert content_type_for_path("photo.jpg") == ContentType.IMAGE_JPEG
    assert content_type_for_path("photo.jpeg") == ContentType.IMAGE_JPEG
    assert content_type_for_path("logo.png") == ContentType.IMAGE_PNG
    assert content_type_for_path("doc.pdf") == ContentType.PDF
    assert content_type_for_path("build.log") == ContentType.TEXT
    assert content_type_for_path("dump.gzip") == ContentType.GZIP
    assert content_type_for_path("unknown.blob") == ContentType.BINARY


def test_content_type_for_path_reads_the_last_segment_only():
    assert content_type_for_path("/v1.2/README") == ContentType.BINARY
    assert content_type_for_path("/v1.2/notes.md") == ContentType.TEXT


def test_content_type_for_extension():
    assert content_type_for_extension("png") == ContentType.IMAGE_PNG
    assert content_type_for_extension("JPG") == ContentType.IMAGE_JPEG
    assert content_type_for_extension("txt") == ContentType.TEXT
    assert content_type_for_extension("blob") == ContentType.BINARY


def test_content_type_for_mime():
    assert content_type_for_mime("image/png") == ContentType.IMAGE_PNG
    assert content_type_for_mime("image/jpeg") == ContentType.IMAGE_JPEG
    assert content_type_for_mime("image/gif") == ContentType.IMAGE_GIF
    assert content_type_for_mime("application/pdf") == ContentType.PDF
    assert content_type_for_mime("text/markdown") == ContentType.TEXT
    assert content_type_for_mime("") == ContentType.BINARY
    assert content_type_for_mime(
        "application/octet-stream") == ContentType.BINARY


def test_mime_type_for_uses_the_fixed_table():
    # The table is a deliberate fixed subset shared verbatim with the
    # TypeScript implementation (himalaya attachments pin the bytes).
    assert mime_type_for("report.PDF") == "application/pdf"
    assert mime_type_for("notes.txt") == "text/plain"
    assert mime_type_for("archive.weird") == "application/octet-stream"
    assert mime_type_for("no_extension") == "application/octet-stream"
