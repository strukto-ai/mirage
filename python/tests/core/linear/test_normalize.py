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

from mirage.core.linear.normalize import normalize_document, normalize_label


def test_normalize_label_maps_fields():
    label = {"id": "lbl_1", "name": "bug", "color": "#ff0000"}
    assert normalize_label(label) == {
        "label_id": "lbl_1",
        "name": "bug",
        "color": "#ff0000",
    }


def test_normalize_label_tolerates_missing_fields():
    assert normalize_label({"id": "lbl_2"}) == {
        "label_id": "lbl_2",
        "name": None,
        "color": None,
    }


def test_normalize_document_resolves_project_and_creator():
    document = {
        "id": "doc_1",
        "title": "Runbook",
        "content": "restart the worker",
        "createdAt": "2026-05-01T00:00:00.000Z",
        "updatedAt": "2026-05-02T00:00:00.000Z",
        "url": "https://linear.app/strukto/document/doc_1",
        "project": {
            "id": "prj_1",
            "name": "Search"
        },
        "creator": {
            "id": "usr_1",
            "name": "alex",
            "email": "alex@x.io"
        },
    }
    assert normalize_document(document) == {
        "document_id": "doc_1",
        "title": "Runbook",
        "content": "restart the worker",
        "project_id": "prj_1",
        "project_name": "Search",
        "creator_id": "usr_1",
        "creator_name": "alex",
        "creator_email": "alex@x.io",
        "created_at": "2026-05-01T00:00:00.000Z",
        "updated_at": "2026-05-02T00:00:00.000Z",
        "url": "https://linear.app/strukto/document/doc_1",
    }


def test_normalize_document_defaults_content_and_nulls():
    assert normalize_document({
        "id": "doc_2",
        "title": "Empty"
    }) == {
        "document_id": "doc_2",
        "title": "Empty",
        "content": "",
        "project_id": None,
        "project_name": None,
        "creator_id": None,
        "creator_name": None,
        "creator_email": None,
        "created_at": None,
        "updated_at": None,
        "url": None,
    }
