import json

from mirage.core.qdrant.render import render_json, render_text
from mirage.resource.qdrant.config import QdrantConfig


def _cfg() -> QdrantConfig:
    return QdrantConfig(id_field="id",
                        text_field="name",
                        blob_field="image_bytes",
                        blob_ext="png",
                        vector_field="vector")


def test_render_json_omits_vector_and_blob():
    row = {
        "id": 3,
        "name": "a big brown dog",
        "label": "dog",
        "image_bytes": "UE5HLTM=",
        "vector": [0.1, 0.2],
    }
    payload = json.loads(render_json(row, _cfg()).decode())
    assert payload == {"id": 3, "name": "a big brown dog", "label": "dog"}


def test_render_json_is_compact():
    out = render_json({"id": 1, "name": "x"}, _cfg()).decode()
    assert out == '{"id":1,"name":"x"}\n'


def test_render_text_returns_source_text():
    out = render_text({"id": 3, "name": "a big brown dog"}, _cfg()).decode()
    assert out == "a big brown dog\n"


def test_render_text_empty_when_field_missing():
    assert render_text({"id": 3}, _cfg()) == b""
