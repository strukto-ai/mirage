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

import os

import pytest

from mirage.vfs import registry
from mirage.vfs.base import BaseVFS
from mirage.vfs.hf_buckets import HfBucketsVFS
from mirage.vfs.registry import (
    REGISTRY,
    build_vfs,
    known_vfs_names,
    register_vfs,
)


def test_build_ram_returns_ram_vfs():
    from mirage.vfs.ram import RAMVFS

    p = build_vfs("ram")
    assert isinstance(p, RAMVFS)


def test_build_disk_takes_raw_kwargs(tmp_path):
    from mirage.vfs.disk import DiskVFS

    p = build_vfs("disk", {"root": str(tmp_path)})
    assert isinstance(p, DiskVFS)


def test_build_s3_uses_config_class():
    from mirage.vfs.s3 import S3VFS

    p = build_vfs(
        "s3",
        {
            "bucket": "b",
            "region": "us-east-1",
            "aws_access_key_id": "k",
            "aws_secret_access_key": "s",
        },
    )
    assert isinstance(p, S3VFS)
    assert p.config.bucket == "b"
    assert p.config.region == "us-east-1"


def test_build_r2_uses_r2_config():
    from mirage.vfs.r2 import R2VFS

    p = build_vfs(
        "r2",
        {
            "bucket": "b",
            "account_id": "acct",
            "access_key_id": "k",
            "secret_access_key": "s",
        },
    )
    assert isinstance(p, R2VFS)


@pytest.mark.skipif(
    not os.environ.get("REDIS_URL"), reason="REDIS_URL not set"
)
def test_build_redis_takes_raw_kwargs():
    from mirage.vfs.redis import RedisVFS

    p = build_vfs(
        "redis",
        {
            "url": os.environ["REDIS_URL"],
            "key_prefix": "test:",
        },
    )
    assert isinstance(p, RedisVFS)


def test_unknown_vfs_raises_keyerror():
    with pytest.raises(KeyError, match="unknown VFS 'nonsense'"):
        build_vfs("nonsense")


def test_registry_module_import_is_free_of_vfs_deps():
    import importlib
    import sys

    if "mirage.vfs.registry" in sys.modules:
        del sys.modules["mirage.vfs.registry"]
    importlib.import_module("mirage.vfs.registry")


def test_build_hf_buckets_vfs():
    r = build_vfs("hf_buckets", {"bucket": "o/b"})
    assert isinstance(r, HfBucketsVFS)


class FakeCustomConfig:
    def __init__(self, url: str = "") -> None:
        self.url = url


# The colon rung is the one that accepts a class subclassing nothing, so
# these stand in for a real out-of-tree backend and subclass BaseVFS
# the way one does. NotAVFS below is the class that does not, and
# NamelessVFS is a real subclass that leaves the key empty.
class FakeCustomVFS(BaseVFS):
    name = "fake_custom"

    def __init__(self, config: FakeCustomConfig) -> None:
        super().__init__()
        self.config = config


class FakeKwargsVFS(BaseVFS):
    name = "fake_kwargs"

    def __init__(self, root: str = "/") -> None:
        super().__init__()
        self.root = root


class FakeConfigClsVFS(BaseVFS):
    name = "fake_attr"
    CONFIG_CLS = FakeCustomConfig

    def __init__(self, config: FakeCustomConfig) -> None:
        super().__init__()
        self.config = config


class NotAVFS:
    def __init__(self, root: str = "/") -> None:
        self.root = root


class NamelessVFS(BaseVFS):
    name = ""


@pytest.fixture
def clean_registry(monkeypatch):
    monkeypatch.setattr(registry, "_CUSTOM", {})
    monkeypatch.setattr(registry, "_entry_points_loaded", False)


def test_register_vfs_class_and_config(clean_registry):
    register_vfs("fake_custom", FakeCustomVFS, FakeCustomConfig)
    built = build_vfs("fake_custom", {"url": "http://x"})
    assert isinstance(built, FakeCustomVFS)
    assert built.config.url == "http://x"


def test_register_vfs_kwargs_config(clean_registry):
    register_vfs("fake_kwargs", FakeKwargsVFS)
    built = build_vfs("fake_kwargs", {"root": "/data"})
    assert isinstance(built, FakeKwargsVFS)
    assert built.root == "/data"


def test_register_vfs_config_cls_attribute(clean_registry):
    register_vfs("fake_attr", FakeConfigClsVFS)
    built = build_vfs("fake_attr", {"url": "http://y"})
    assert built.config.url == "http://y"


def test_register_vfs_rejects_builtin_shadow(clean_registry):
    with pytest.raises(ValueError):
        register_vfs("s3", FakeCustomVFS)


def test_register_vfs_spec_string(clean_registry):
    register_vfs("fake_spec", "tests.vfs.test_registry:FakeKwargsVFS")
    built = build_vfs("fake_spec", {"root": "/spec"})
    assert built.root == "/spec"


def test_colon_reference_builds_without_a_registry(clean_registry):
    # A colon means the value names code, so it resolves with nothing
    # registered and no entry points scanned.
    built = build_vfs(
        "tests.vfs.test_registry:FakeKwargsVFS", {"root": "/ref"}
    )
    assert isinstance(built, FakeKwargsVFS)
    assert built.root == "/ref"


def test_colon_reference_uses_the_config_cls_attribute(clean_registry):
    built = build_vfs(
        "tests.vfs.test_registry:FakeConfigClsVFS", {"url": "http://ref"}
    )
    assert built.config.url == "http://ref"


def test_colon_reference_does_not_shadow_a_builtin_name(clean_registry):
    # A registry name always wins, so a name can never be reread as code.
    assert type(build_vfs("ram")).__name__ == "RAMVFS"


def test_colon_reference_to_a_missing_attribute_raises(clean_registry):
    with pytest.raises(ValueError):
        build_vfs("tests.vfs.test_registry:NoSuchVFS")


def test_colon_reference_refuses_a_class_that_is_not_a_vfs(clean_registry):
    # Nothing validated this rung, so a class subclassing nothing reached
    # install_mounts and then crashed there on a method the caller never
    # called. The subclass check is the same one check_vfs makes at
    # the mount entry point, moved to the dispatcher the author actually
    # called.
    with pytest.raises(TypeError, match="not a BaseVFS subclass"):
        build_vfs("tests.vfs.test_registry:NotAVFS")


def test_colon_reference_refuses_a_vfs_with_no_name(clean_registry):
    # The name is how a command or op registered for this backend is
    # found, so an empty one registers nothing and fails nowhere.
    with pytest.raises(TypeError, match="has no name"):
        build_vfs("tests.vfs.test_registry:NamelessVFS")


def test_a_registry_name_is_not_re_validated(clean_registry):
    # Only the colon rung is checked: a builtin is known good, and
    # register_vfs is called by the embedding program.
    register_vfs("fake_bare", NotAVFS)
    assert build_vfs("fake_bare", {"root": "/x"}).root == "/x"


def test_known_vfs_names_includes_custom(clean_registry):
    register_vfs("fake_custom", FakeCustomVFS, FakeCustomConfig)
    names = known_vfs_names()
    assert "fake_custom" in names
    assert "s3" in names


def test_entry_point_discovery(clean_registry, monkeypatch):
    import importlib.metadata

    ep = importlib.metadata.EntryPoint(
        name="fake_ep",
        value="tests.vfs.test_registry:FakeKwargsVFS",
        group="mirage.vfs",
    )

    def fake_entry_points(*, group):
        assert group == "mirage.vfs"
        return [ep]

    monkeypatch.setattr(importlib.metadata, "entry_points", fake_entry_points)
    built = build_vfs("fake_ep", {"root": "/ep"})
    assert built.root == "/ep"
    assert "fake_ep" in known_vfs_names()


def test_entry_point_does_not_shadow_registered(clean_registry, monkeypatch):
    import importlib.metadata

    ep = importlib.metadata.EntryPoint(
        name="fake_custom",
        value="tests.vfs.test_registry:FakeKwargsVFS",
        group="mirage.vfs",
    )
    monkeypatch.setattr(
        importlib.metadata, "entry_points", lambda *, group: [ep]
    )
    register_vfs("fake_custom", FakeCustomVFS, FakeCustomConfig)
    built = build_vfs("fake_custom", {"url": "http://z"})
    assert isinstance(built, FakeCustomVFS)


def test_unknown_vfs_lists_known(clean_registry):
    with pytest.raises(KeyError, match="unknown VFS"):
        build_vfs("nope_not_real")


def test_a_refused_config_value_is_not_in_the_error():
    """`mounts.*.config` is where a fetched credential lands, and the
    create route answers `str(e)` as its 400 detail. Pydantic puts the
    value it refused in `input_value`, so an unparseable secret came
    back to a caller whose only way to name it was a pointer."""
    secret = "sk-live-notanumber"
    with pytest.raises(ValueError) as caught:
        build_vfs("ssh", {"host": "example.com", "port": secret})
    message = str(caught.value)
    assert secret not in message
    assert "port" in message
    # The chain would carry the value into any logged traceback.
    assert caught.value.__cause__ is None


class FakeOpenKwargsVFS(BaseVFS):
    name = "fake_open"

    def __init__(self, **options: str) -> None:
        super().__init__()
        self.options = options


def test_an_unknown_config_key_is_refused_by_name():
    """A key no field takes used to be dropped without a word, so a
    typo'd ``team_idz`` built a linear mount that exposed every team."""
    with pytest.raises(ValueError) as caught:
        build_vfs("linear", {"api_key": "k", "team_idz": ["x"]})
    assert str(caught.value) == "linear: team_idz: extra_forbidden"


def test_every_unknown_key_is_named_in_the_order_given():
    with pytest.raises(ValueError) as caught:
        build_vfs("s3", {"bucket": "b", "one": 1, "two": 2})
    assert str(caught.value) == (
        "s3: one: extra_forbidden; two: extra_forbidden"
    )


@pytest.mark.parametrize(
    ("name", "config", "message"),
    [
        ("ram", {"root": "/tmp"}, "ram: root: extra_forbidden"),
        (
            "disk",
            {"root": "/tmp", "roots": "/x"},
            "disk: roots: extra_forbidden",
        ),
        ("redis", {"keyprefix": "a"}, "redis: keyprefix: extra_forbidden"),
    ],
)
def test_a_kwargs_vfs_refuses_an_unknown_key_in_the_same_words(
    name, config, message
):
    # These three take constructor keywords rather than a typed config,
    # so an unknown key used to surface as Python's own TypeError.
    with pytest.raises(ValueError) as caught:
        build_vfs(name, config)
    assert str(caught.value) == message


def test_a_constructor_taking_kwargs_judges_its_own_keys(clean_registry):
    register_vfs("fake_open", FakeOpenKwargsVFS)
    built = build_vfs("fake_open", {"anything": "x"})
    assert built.options == {"anything": "x"}


@pytest.mark.parametrize("key", ["schema", "schema_name"])
def test_an_aliased_field_is_known_under_either_name(key):
    built = build_vfs(
        "databricks_volume",
        {
            "catalog": "c",
            key: "s",
            "volume": "v",
            "host": "https://h",
            "token": "t",
        },
    )
    assert built.config.schema_name == "s"


@pytest.mark.parametrize(
    "name",
    sorted(n for n, e in REGISTRY.items() if e.config_path is not None),
)
def test_every_registry_config_is_frozen_and_forbids_extra_keys(name):
    """pydantic's default ``extra="ignore"`` drops a key no field takes,
    and a mutable config lets a write after construction drift from what
    the accessor was built with and what a snapshot recorded. Every class
    the registry can build is checked, subclasses included, because a
    subclass may set its own ``model_config``."""
    cls = registry.resolve_class(REGISTRY[name].config_path)
    assert cls.model_config.get("frozen") is True
    assert cls.model_config.get("extra") == "forbid"


@pytest.mark.parametrize("name", sorted(REGISTRY))
def test_every_registry_vfs_is_named_after_its_entry(name):
    """The name is what a mount registers commands under and what a
    snapshot records as the ``type``, so it must lead back to the entry;
    the S3-compatible aliases inherited ``s3`` and saved their own configs
    under it. TypeScript's aliases always carried their own."""
    assert registry.resolve_class(REGISTRY[name].vfs_path).name == name
