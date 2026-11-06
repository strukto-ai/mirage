import pytest
import yaml

from mirage.utils.yaml import dump_yaml, parse_yaml


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("1e3", 1000),
        ("1E+3", 1000),
        ("1.0e3", 1000),
        ("1.e3", 1000),
        ("+.1e4", 1000),
        ("10000e-1", 1000),
        ("1e-3", 0.001),
        ("-1e3", -1000),
    ],
)
def test_exponent_scalars_are_numbers(source: str, expected: float):
    assert parse_yaml(f"ttl: {source}") == {"ttl": expected}


def test_explicit_strings_stay_strings():
    assert parse_yaml("values: ['1e3', \"1e3\", !!str 1e3]") == {
        "values": ["1e3", "1e3", "1e3"]
    }


def test_json_numbers_are_preserved():
    assert parse_yaml('{"ttl": 1e3, "enabled": true, "optional": null}') == {
        "ttl": 1000,
        "enabled": True,
        "optional": None,
    }


def test_exponent_resolver_does_not_change_pyyaml_safe_load():
    assert parse_yaml("1e3") == 1000
    assert yaml.safe_load("1e3") == "1e3"


def test_python_object_tags_are_rejected():
    with pytest.raises(yaml.constructor.ConstructorError):
        parse_yaml("!!python/tuple [1, 2]")


@pytest.mark.parametrize(
    "text", ["1e3", "off", "yes", "1_000", "0o17", "2026-01-02", "~", "null"]
)
def test_dumped_strings_read_back_as_strings(text: str):
    doc = {"env": {"VALUE": text}, text: "key"}
    assert parse_yaml(dump_yaml(doc)) == doc
