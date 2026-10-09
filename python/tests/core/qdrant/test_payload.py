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

from mirage.core.qdrant.payload import field_value, without_field


def test_field_value_reads_a_dotted_payload_path():
    row = {"metadata": {"source": "report.pdf", "page": 4}}
    assert field_value(row, "metadata.source") == "report.pdf"
    assert field_value(row, "metadata.missing") is None


def test_a_dotted_key_uses_qdrants_nested_field_semantics():
    row = {"metadata.source": "literal", "metadata": {"source": "nested"}}
    assert field_value(row, "metadata.source") == "nested"


def test_without_field_removes_a_nested_value_without_mutating_the_row():
    row = {"metadata": {"source": "report.pdf", "blob": "bytes"}}
    copied = without_field(row, "metadata.blob")
    assert copied == {"metadata": {"source": "report.pdf"}}
    assert row["metadata"]["blob"] == "bytes"


@pytest.mark.parametrize("field", ["__proto__", "constructor", "toString"])
def test_field_value_reads_only_owned_fields(field):
    assert field_value({}, field) is None
    assert field_value({"metadata": {}}, f"metadata.{field}") is None
    assert field_value({field: "payload"}, field) == "payload"


def test_without_field_preserves_prototype_named_keys():
    row = {"__proto__": {"keep": "value", "blob": "bytes"}, "vector": [1]}
    copied = without_field(without_field(row, "vector"), "__proto__.blob")
    assert copied == {"__proto__": {"keep": "value"}}
    assert row["__proto__"]["blob"] == "bytes"
