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

from mirage.core.hierarchy.codec import PATH_SAFE
from mirage.core.qdrant.naming import group_name, point_id_from_stem, row_stem
from mirage.utils.sanitize import NAME_MAX_BYTES, byte_len
from mirage.vfs.qdrant.config import QdrantConfig


def test_source_url_can_render_as_its_basename():
    assert group_name("s3://docs/policies/refund-2026.pdf",
                      basename=True) == "refund-2026.pdf"


def test_group_name_renders_through_the_shared_path_safe_codec():
    # ``/`` renders as ``∕`` and a value already holding ``∕`` or ``⁄`` has
    # that character escaped, so ``a/b`` and ``a∕b`` cannot name one
    # directory and the scope table decodes each back to its own value.
    # A basename leaf renders the same way; only its parents are dropped.
    assert group_name("a/b") == "a∕b"
    assert group_name("a∕b") == "a⁄∕b"
    for raw in ("plain", "a/b", "a∕b", "a⁄b"):
        assert PATH_SAFE.decode(group_name(raw)) == raw
    assert group_name("s3://x/y∕z.pdf", basename=True) == "y⁄∕z.pdf"


def test_name_field_keeps_the_point_id_for_reverse_lookup():
    config = QdrantConfig(name_field="metadata.page")
    row = {"id": 17, "metadata": {"page": "004"}}
    stem = row_stem(row, config)
    assert stem == "004__17"
    assert point_id_from_stem(stem, config) == "17"


def test_dotted_id_field_is_read_as_the_literal_synthetic_key():
    config = QdrantConfig(id_field="meta.id", name_field="title")
    stem = row_stem({"meta.id": 17, "title": "report"}, config)
    assert stem == "report__17"
    assert point_id_from_stem(stem, config) == "17"


def test_row_stem_reserves_room_for_every_enabled_suffix():
    config = QdrantConfig(name_field="title",
                          text_field="text",
                          blob_field="blob",
                          blob_ext="very-long-extension")
    stem = row_stem({"id": 17, "title": "界" * 200}, config)
    for suffix in (".json", ".txt", ".very-long-extension"):
        assert byte_len(f"{stem}{suffix}") <= NAME_MAX_BYTES
    assert point_id_from_stem(stem, config) == "17"


def test_missing_name_field_falls_back_to_the_point_id():
    config = QdrantConfig(name_field="metadata.page")
    assert row_stem({"id": 17}, config) == "17"
    assert point_id_from_stem("17", config) == "17"


def test_group_name_spells_a_non_string_value_as_its_json_does():
    # ``str(True)`` is ``True`` where TypeScript's ``String(true)`` is
    # ``true``, so one collection would grow two different trees. A
    # non-string value spells the way the point's ``.json`` spells it.
    assert group_name(True) == "true"
    assert group_name(1.0) == "1"
    assert group_name(7) == "7"
    assert group_name("True") == "True"


def test_group_name_keeps_blank_and_dot_led_values_addressable():
    # A blank value used to render as ``unknown`` and a dot-led one as a
    # hidden segment; both carry the escape lead and decode back exactly.
    assert group_name("") == "⁄"
    assert group_name(".env") == "⁄.env"
    assert group_name("s3://bucket/.env", basename=True) == "⁄.env"
    for raw in ("", ".env"):
        assert PATH_SAFE.decode(group_name(raw)) == raw


def test_row_stem_spells_a_non_string_label_as_its_json_does():
    config = QdrantConfig(name_field="flag")
    assert row_stem({"id": 17, "flag": True}, config) == "true__17"
    assert row_stem({"id": 17, "flag": 1.0}, config) == "1__17"
    assert row_stem({"id": 17, "flag": 1e-7}, config) == "1e-7__17"
    assert row_stem({"id": 17, "flag": {"a": 1.0}}, config) == '{"a":1}__17'


def test_row_stem_keeps_a_dot_led_label_openable():
    # A leaf named ``.env__17.json`` is hidden from the listing and
    # refused as a path, so the label takes the escape lead. A blank
    # label keeps the readable ``unknown`` fallback: the id addresses.
    config = QdrantConfig(name_field="title")
    assert row_stem({"id": 17, "title": ".env"}, config) == "⁄.env__17"
    assert point_id_from_stem("⁄.env__17", config) == "17"
    assert row_stem({"id": 17, "title": ""}, config) == "unknown__17"


def test_a_basename_past_name_max_is_cut_and_keeps_its_identity():
    # A leaf longer than NAME_MAX rendered whole, and ext4 and APFS refuse
    # such a name over a FUSE mount, so the rows under it could not be
    # opened. The segment is cut to fit and keeps the md5 of the whole leaf
    # as its id, the ``<label>__<id>`` shape every long name takes, so two
    # leaves that agree for 255 bytes stay two directories.
    long_a = group_name(f"s3://docs/{'r' * 300}a.pdf", basename=True)
    long_b = group_name(f"s3://docs/{'r' * 300}b.pdf", basename=True)
    assert long_a == "r" * 221 + "__ba0797292207781661c03dea74339808"
    assert long_b != long_a
    wide = group_name(f"s3://docs/{'界' * 100}", basename=True)
    assert byte_len(wide) <= NAME_MAX_BYTES
    assert "\ufffd" not in wide
    assert wide.endswith("__51d13188e994b54376bb4693d036cf61")
    assert group_name(f"s3://docs/{'r' * 255}", basename=True) == "r" * 255
