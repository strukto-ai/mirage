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

from mirage.types import FileType
from mirage.utils.filetype import (_MIMETYPE_MAP, EXTENSION_MAP,
                                   IMAGE_TYPE_BY_EXTENSION, MIME_BY_EXTENSION,
                                   filetype_from_mimetype, guess_type,
                                   image_type_for_extension, mime_type_for)

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
        for k, v in EXTENSION_MAP.items()
    } == tables["extension_map"]
    assert MIME_BY_EXTENSION == tables["mime_by_extension"]
    assert {
        k: v.value
        for k, v in _MIMETYPE_MAP.items()
    } == tables["mimetype_map"]
    assert ({
        k: v.value
        for k, v in IMAGE_TYPE_BY_EXTENSION.items()
    } == tables["image_type_by_extension"])


def test_log_and_gzip_extensions():
    assert guess_type("build.log") == FileType.TEXT
    assert guess_type("dump.gzip") == FileType.GZIP


def test_image_type_for_extension():
    assert image_type_for_extension("png") == FileType.IMAGE_PNG
    assert image_type_for_extension("JPG") == FileType.IMAGE_JPEG
    assert image_type_for_extension("txt") == FileType.BINARY


def test_jpg_extension_maps_to_jpeg():
    assert guess_type("photo.jpg") == FileType.IMAGE_JPEG


def test_jpeg_extension_maps_to_jpeg():
    assert guess_type("photo.jpeg") == FileType.IMAGE_JPEG


def test_png_extension():
    assert guess_type("logo.png") == FileType.IMAGE_PNG


def test_pdf_extension():
    assert guess_type("doc.pdf") == FileType.PDF


def test_filetype_from_mimetype_image():
    assert filetype_from_mimetype("image/png") == FileType.IMAGE_PNG
    assert filetype_from_mimetype("image/jpeg") == FileType.IMAGE_JPEG
    assert filetype_from_mimetype("image/gif") == FileType.IMAGE_GIF


def test_filetype_from_mimetype_pdf():
    assert filetype_from_mimetype("application/pdf") == FileType.PDF


def test_filetype_from_mimetype_text_fallback():
    assert filetype_from_mimetype("text/markdown") == FileType.TEXT


def test_filetype_from_mimetype_empty():
    assert filetype_from_mimetype("") == FileType.BINARY


def test_filetype_from_mimetype_unknown():
    assert filetype_from_mimetype(
        "application/octet-stream") == FileType.BINARY


def test_mime_type_for_uses_the_fixed_table():
    # The table is a deliberate fixed subset shared verbatim with the
    # TypeScript implementation (himalaya attachments pin the bytes).
    assert mime_type_for("report.PDF") == "application/pdf"
    assert mime_type_for("notes.txt") == "text/plain"
    assert mime_type_for("archive.weird") == "application/octet-stream"
    assert mime_type_for("no_extension") == "application/octet-stream"
