from mirage.core.qdrant.fields import (field_value, group_name,
                                       point_id_from_stem, row_stem,
                                       without_field)
from mirage.resource.qdrant.config import QdrantConfig
from mirage.utils.sanitize import NAME_MAX_BYTES, byte_len


def test_field_value_reads_a_dotted_payload_path():
    row = {"metadata": {"source": "report.pdf", "page": 4}}
    assert field_value(row, "metadata.source") == "report.pdf"
    assert field_value(row, "metadata.missing") is None


def test_a_dotted_key_uses_qdrants_nested_field_semantics():
    row = {"metadata.source": "literal", "metadata": {"source": "nested"}}
    assert field_value(row, "metadata.source") == "nested"


def test_source_url_can_render_as_its_basename():
    assert group_name("s3://docs/policies/refund-2026.pdf",
                      basename=True) == "refund-2026.pdf"


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


def test_without_field_removes_a_nested_value_without_mutating_the_row():
    row = {"metadata": {"source": "report.pdf", "blob": "bytes"}}
    copied = without_field(row, "metadata.blob")
    assert copied == {"metadata": {"source": "report.pdf"}}
    assert row["metadata"]["blob"] == "bytes"
