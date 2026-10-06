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

from mirage.cache.index import IndexConfig
from mirage.types import DEFAULT_READ_TTL, MountMode, ReadPolicy, ReadSpec
from mirage.vfs.aliyun.aliyun import AliyunVFS
from mirage.vfs.backblaze.backblaze import BackblazeVFS
from mirage.vfs.base import BaseVFS
from mirage.vfs.ceph.ceph import CephVFS
from mirage.vfs.dev.dev import DevVFS
from mirage.vfs.digitalocean.digitalocean import DigitalOceanVFS
from mirage.vfs.disk.disk import DiskVFS
from mirage.vfs.gcs.gcs import GCSVFS
from mirage.vfs.gdocs import GDocsConfig, GDocsVFS
from mirage.vfs.gdrive import GoogleDriveConfig, GoogleDriveVFS
from mirage.vfs.gridfs import GridFSConfig
from mirage.vfs.gridfs.gridfs import GridFSVFS
from mirage.vfs.gsheets import GSheetsConfig, GSheetsVFS
from mirage.vfs.gslides import GSlidesConfig, GSlidesVFS
from mirage.vfs.hf_buckets import HfBucketsConfig, HfBucketsVFS
from mirage.vfs.lancedb import LanceDBConfig, LanceDBVFS
from mirage.vfs.loader import load_attr
from mirage.vfs.minio.config import MinIOConfig
from mirage.vfs.minio.minio import MinIOVFS
from mirage.vfs.nextcloud.config import NextcloudConfig
from mirage.vfs.nextcloud.nextcloud import NextcloudVFS
from mirage.vfs.oci.oci import OCIVFS
from mirage.vfs.qingstor.qingstor import QingStorVFS
from mirage.vfs.r2.r2 import R2VFS
from mirage.vfs.ram.ram import RAMVFS
from mirage.vfs.registry import REGISTRY, build_vfs, known_vfs_names
from mirage.vfs.s3 import S3VFS, S3Config
from mirage.vfs.scaleway.scaleway import ScalewayVFS
from mirage.vfs.seaweedfs.seaweedfs import SeaweedFSVFS
from mirage.vfs.ssh.config import SSHConfig
from mirage.vfs.ssh.ssh import SSHVFS
from mirage.vfs.supabase.supabase import SupabaseVFS
from mirage.vfs.tencent.tencent import TencentVFS
from mirage.vfs.wasabi.wasabi import WasabiVFS
from mirage.workspace import Workspace
from mirage.workspace.mount import Mount
from mirage.workspace.mount.read_policy import (
    check_read_capability,
    coerce_read_policy,
    resolve_read_spec,
)

FRESH = ReadSpec(policy=ReadPolicy.FRESH)

# Every S3-compatible provider reaches the verdict through S3VFS, so the
# flag is declared once and inherited. Listing them is what catches a new
# provider that stops inheriting.
S3_ALIASES = [
    AliyunVFS,
    BackblazeVFS,
    CephVFS,
    DigitalOceanVFS,
    GCSVFS,
    MinIOVFS,
    OCIVFS,
    QingStorVFS,
    R2VFS,
    ScalewayVFS,
    SeaweedFSVFS,
    SupabaseVFS,
    TencentVFS,
    WasabiVFS,
]


def test_absent_policy_is_bounded_at_the_default_bound():
    assert resolve_read_spec(None, None) == ReadSpec(
        policy=ReadPolicy.BOUNDED, ttl=DEFAULT_READ_TTL
    )


def test_empty_policy_reads_as_absent():
    assert resolve_read_spec("", None).policy is ReadPolicy.BOUNDED


def test_an_already_coerced_policy_passes_through():
    # str() of a (str, Enum) member is "ReadPolicy.BOUNDED", so a second
    # coercion of an already-coerced value would refuse it. The config
    # door validates the field and then builds the spec, so it happens.
    assert coerce_read_policy(ReadPolicy.FRESH) is ReadPolicy.FRESH
    assert resolve_read_spec(ReadPolicy.BOUNDED, 30) == ReadSpec(
        policy=ReadPolicy.BOUNDED, ttl=30
    )


def test_policy_name_is_case_insensitive():
    assert resolve_read_spec("FRESH", None).policy is ReadPolicy.FRESH


def test_declared_bound_is_kept():
    assert resolve_read_spec("bounded", 30).ttl == 30


def test_a_bound_must_be_whole_positive_seconds():
    """A zero or negative bound is an entry that is stale the instant
    it is written, and a float or a bool is a bound the store cannot
    compare against; the coercer is the one place that can say so
    before a mount installs."""
    for bad in (0, -1, -600):
        with pytest.raises(ValueError, match="at least 1 second"):
            resolve_read_spec("bounded", bad)
    for junk in (1.5, True, "600"):
        with pytest.raises(ValueError, match="whole seconds"):
            resolve_read_spec("bounded", junk)


def test_an_integral_float_bound_resolves_to_the_int():
    # JavaScript has one number type, so `ttl: 60.0` reaches
    # `resolveReadSpec` as plain `60`; refusing it here would refuse a
    # snapshot TypeScript restores. The fractional case above still
    # refuses on both.
    spec = resolve_read_spec("bounded", 60.0)
    assert spec.ttl == 60
    assert isinstance(spec.ttl, int)


def test_unknown_policy_names_the_known_ones():
    with pytest.raises(ValueError) as exc:
        resolve_read_spec("banana", None)
    assert "fresh, bounded, pinned" in str(exc.value)


@pytest.mark.parametrize(
    ("bad", "message"),
    [
        (0, "at least 1 second"),
        (-1, "at least 1 second"),
        (1.5, "whole seconds"),
        (True, "whole seconds"),
    ],
)
def test_the_verdict_refuses_a_bound_no_mount_could_use(bad, message):
    """The programmatic door bypasses ``resolve_read_spec`` entirely.

    A `ReadSpec` handed straight to `Workspace` or `add_mount` never
    passes through the coercer, so before this the mount was accepted
    and then kept nothing: RAM marks a ttl=0 entry expired as it is
    written and redis deletes the key, which is caching silently
    disabled rather than a refusal. Checked after the policy name and
    ahead of the policy dispatch, because `bounded` returns from that
    dispatch first.
    """
    spec = ReadSpec(policy=ReadPolicy.BOUNDED, ttl=bad)
    with pytest.raises(ValueError, match=message):
        check_read_capability("/d/", RAMVFS(), spec)


def test_a_bad_bound_is_refused_at_the_workspace_door_too():
    with pytest.raises(ValueError, match="at least 1 second"):
        Workspace(
            {"/d": RAMVFS()},
            mode=MountMode.WRITE,
            read=ReadSpec(policy=ReadPolicy.BOUNDED, ttl=0),
        )


@pytest.mark.parametrize("policy", ["fresh", "pinned"])
def test_a_wire_string_policy_is_judged_like_the_enum(policy):
    """`ReadPolicy` is a (str, Enum) and `ReadSpec` coerces nothing.

    An embedder writing ``ReadSpec(policy="fresh")`` against the public
    API matched neither `is` in the verdict, so the whole check silently
    no-opped on the one door that skips ``resolve_read_spec``. On a
    backend that *can* revalidate it was worse: the mount passed and
    then read as `bounded` everywhere downstream, which is the silent
    downgrade this policy exists to remove.
    """
    with pytest.raises(ValueError):
        check_read_capability("/d/", RAMVFS(), ReadSpec(policy=policy, ttl=30))


def test_a_mount_stores_the_coerced_policy_not_the_wire_string():
    # Downstream -- the gate, the routing reconcile -- all compare with
    # `is`, so the spec has to be normalized where it becomes live mount
    # state or a capable backend mounts `fresh` and behaves as bounded.
    vfs = S3VFS(S3Config(bucket="b"))
    ws = Workspace(
        {"/s3": vfs},
        mode=MountMode.WRITE,
        read=ReadSpec(policy="fresh", ttl=30),
    )
    mount = ws._registry.mount_for_prefix("/s3/")
    assert mount.read.policy is ReadPolicy.FRESH


def test_the_two_doors_refuse_a_doubly_bad_config_the_same_way():
    # TypeScript's `resolveReadSpec` names the policy first; python has
    # to agree, or one document yields two different refusals across the
    # shared config fixtures.
    with pytest.raises(ValueError, match="unknown read policy"):
        resolve_read_spec("banana", 0)


def test_the_verdict_names_the_policy_before_the_bound():
    """The coercer's order, applied at the mount door too.

    `check_read_capability` judged the bound first while
    `checkReadCapability` judged the policy first, so one
    `ReadSpec(policy="banana", ttl=0)` came back naming the bound on
    python and the policy on TypeScript -- and an embedder fixing what
    it was told was wrong hit the other refusal next.
    """
    spec = ReadSpec(policy="banana", ttl=0)
    with pytest.raises(ValueError, match="unknown read policy"):
        check_read_capability("/d/", RAMVFS(), spec)


def test_pinned_is_refused_naming_the_missing_layer():
    with pytest.raises(ValueError) as exc:
        check_read_capability(
            "/d/", RAMVFS(), ReadSpec(policy=ReadPolicy.PINNED)
        )
    assert "needs a version layer to pin to" in str(exc.value)
    assert "use fresh or bounded" in str(exc.value)


def test_fresh_is_refused_on_ram_which_caches_nothing():
    with pytest.raises(ValueError) as exc:
        check_read_capability("/d/", RAMVFS(), FRESH)
    assert "needs a resource that caches reads or listings" in str(exc.value)
    assert "ram caches neither" in str(exc.value)


@pytest.mark.parametrize(
    "name, config",
    [
        ("postgres", {"dsn": "postgresql://x/y"}),
    ],
)
def test_fresh_is_refused_where_listings_live_no_time(name, config):
    vfs = build_vfs(name, config)
    assert vfs.caches_reads is False
    with pytest.raises(ValueError, match="caches reads or listings"):
        check_read_capability("/d/", vfs, FRESH)


def test_fresh_is_allowed_on_disk_which_caches_listings(tmp_path):
    vfs = DiskVFS(root=str(tmp_path))
    assert vfs.caches_reads is False
    check_read_capability("/local/", vfs, FRESH)


@pytest.mark.parametrize(
    "name, config",
    [
        ("chroma", {"collection_name": "c"}),
        ("qdrant", {"url": "http://localhost:6333", "collection": "c"}),
        ("airtable", {"token": "k"}),
        ("wandb", {"entities": ["lab"]}),
    ],
)
def test_fresh_is_allowed_on_a_listing_cache_without_a_file_cache(
    name, config
):
    # fresh has a listing to check here even though no file bytes are kept.
    vfs = build_vfs(name, config)
    assert vfs.caches_reads is False
    check_read_capability("/d/", vfs, FRESH)


def test_fresh_is_refused_on_a_backend_that_caches_but_stamps_nothing():
    # nextcloud reaches the gate -- it caches reads -- but its ETag is a
    # function of a pinnable mtime and the size, no content token, so
    # there is nothing honest to compare.
    vfs = NextcloudVFS(NextcloudConfig(url="https://cloud.example"))
    assert vfs.caches_reads is True
    with pytest.raises(ValueError) as exc:
        check_read_capability("/nc/", vfs, FRESH)
    assert "comparable content token" in str(exc.value)


def test_fresh_is_refused_on_ssh_rather_than_warned():
    # #1101 Q8 recommended warn-and-serve on the grounds that ssh's mtime
    # is forgeable but usable. It is worse than that: ssh stamps no read
    # fingerprint at all, so a cached entry holds no token to compare
    # against an mtime stat token and fresh would refetch on every read.
    vfs = SSHVFS(SSHConfig(host="h", username="u"))
    assert vfs.caches_reads is True
    with pytest.raises(ValueError) as exc:
        check_read_capability("/r/", vfs, FRESH)
    assert "comparable content token" in str(exc.value)


def test_fresh_is_allowed_on_s3():
    vfs = S3VFS(S3Config(bucket="b"))
    assert check_read_capability("/s3/", vfs, FRESH) is None


def test_fresh_is_allowed_on_a_constructed_alias():
    vfs = MinIOVFS(
        MinIOConfig(bucket="b", endpoint_url="http://127.0.0.1:9000")
    )
    assert check_read_capability("/m/", vfs, FRESH) is None


@pytest.mark.parametrize("cls", S3_ALIASES, ids=lambda c: c.__name__)
def test_every_s3_alias_inherits_the_capability(cls):
    assert cls.read_revalidatable is True
    assert cls.caches_reads is True


def test_gridfs_is_allowed_fresh_on_a_constructed_instance():
    # The flag on the class is one line asserting itself; running the
    # verdict on an instance is what proves gridfs can actually declare
    # `fresh`. The token behind the claim is pinned separately, in
    # tests/core/gridfs/test_read_fingerprint.py.
    assert GridFSVFS.read_revalidatable is True
    vfs = GridFSVFS(
        GridFSConfig(uri="mongodb://127.0.0.1:27017", database="d")
    )
    assert vfs.caches_reads is True
    assert check_read_capability("/g/", vfs, FRESH) is None


def test_gdrive_is_allowed_fresh_on_a_constructed_instance():
    # The flag on the class is one line asserting itself; running the
    # verdict on an instance is what proves gdrive can declare `fresh`. The
    # token behind the claim is pinned by the read-token contract,
    # tests/vfs/test_read_revalidatable.py.
    assert GoogleDriveVFS.read_revalidatable is True
    vfs = GoogleDriveVFS(
        GoogleDriveConfig(client_id="c", client_secret="s", refresh_token="r")
    )
    assert vfs.caches_reads is True
    assert check_read_capability("/gd/", vfs, FRESH) is None


@pytest.mark.parametrize(
    ("cls", "config"),
    [
        (GDocsVFS, GDocsConfig),
        (GSheetsVFS, GSheetsConfig),
        (GSlidesVFS, GSlidesConfig),
    ],
)
def test_google_apps_are_allowed_fresh_on_a_constructed_instance(cls, config):
    # Each stamps the file's Drive modifiedTime on stat and read; the
    # read-token contract pins that the two agree.
    assert cls.read_revalidatable is True
    vfs = cls(config(client_id="c", client_secret="s", refresh_token="r"))
    assert vfs.caches_reads is True
    assert check_read_capability("/g/", vfs, FRESH) is None


def test_hf_buckets_is_allowed_fresh_on_a_constructed_instance():
    # The token behind the claim -- stat's paths-info xetHash equals the
    # download's ETag -- is pinned in tests/core/hf_buckets and by the
    # read-token contract; this proves the verdict itself lets it through.
    assert HfBucketsVFS.read_revalidatable is True
    vfs = HfBucketsVFS(HfBucketsConfig(bucket="acme/data"))
    assert vfs.caches_reads is True
    assert check_read_capability("/hf/", vfs, FRESH) is None


def test_bounded_is_allowed_on_a_backend_that_cannot_revalidate():
    assert check_read_capability("/d/", RAMVFS(), ReadSpec()) is None


# The allowlist, spelled out. Asserting the flag on the classes that set
# it only re-reads the line it claims to cover; walking the registry and
# comparing against this set means a new backend cannot quietly declare
# it. That matters because the failure is silent in both directions: a
# backend claiming revalidation it cannot do refetches on every read
# forever, and one that could but does not is refused for no reason.
REVALIDATABLE = {
    "s3",
    "aliyun",
    "backblaze",
    "ceph",
    "digitalocean",
    "gcs",
    "minio",
    "oci",
    "qingstor",
    "r2",
    "scaleway",
    "seaweedfs",
    "supabase",
    "tencent",
    "wasabi",
    "gridfs",
    "gdrive",
    "gdocs",
    "gsheets",
    "gslides",
    "hf_models",
    "hf_datasets",
    "hf_spaces",
    "onedrive",
    "sharepoint",
    "hf_buckets",
    "github",
    "dropbox",
    "box",
}

FRESH_BY_LISTING = {"disk", "chroma", "qdrant", "airtable", "wandb"}


def _stub(name: str) -> BaseVFS | None:
    # The real verdict over each class, unconfigured: it reads only class
    # capabilities and the driver's index_ttl.
    entry = REGISTRY.get(name)
    if entry is None:
        return None
    cls = load_attr(entry.vfs_path)
    vfs = cls.__new__(cls)
    if not hasattr(vfs, "name"):
        vfs.name = name
    return vfs


def test_the_fresh_roster_is_the_revalidatable_ones_plus_listing_caches():
    allowed = set()
    for name in known_vfs_names():
        vfs = _stub(name)
        if vfs is None:
            continue
        try:
            check_read_capability("/x/", vfs, FRESH)
        except ValueError:
            continue
        allowed.add(name)
    assert allowed == REVALIDATABLE | FRESH_BY_LISTING


@pytest.mark.asyncio
async def test_a_workspace_index_is_what_fresh_is_judged_on(tmp_path):
    # RAMVFS declares no listing lifetime of its own, but a workspace index
    # gives it one; the verdict must read the index the mount will use.
    ws = Workspace(
        {"/r": (RAMVFS(), MountMode.WRITE)},
        read=FRESH,
        index=IndexConfig(ttl=600),
    )
    try:
        assert ws._registry.mount_for_prefix("/r/").read.policy is (
            ReadPolicy.FRESH
        )
    finally:
        await ws.close()
    with pytest.raises(ValueError, match="caches reads or listings"):
        Workspace(
            {"/l": DiskVFS(root=str(tmp_path))},
            read=FRESH,
            index=IndexConfig(ttl=0),
        )


@pytest.mark.asyncio
async def test_a_mount_index_is_what_fresh_is_judged_on(tmp_path):
    # A mount's own index overrides the workspace's, both ways.
    ws = Workspace(
        {
            "/r": Mount(
                RAMVFS(), mode=MountMode.WRITE, index=IndexConfig(ttl=600)
            )
        },
        read=FRESH,
    )
    try:
        assert ws._registry.mount_for_prefix("/r/").read.policy is (
            ReadPolicy.FRESH
        )
    finally:
        await ws.close()
    with pytest.raises(ValueError, match="caches reads or listings"):
        Workspace(
            {
                "/l": Mount(
                    DiskVFS(root=str(tmp_path)), index=IndexConfig(ttl=0)
                )
            },
            read=FRESH,
            index=IndexConfig(ttl=600),
        )


@pytest.mark.asyncio
async def test_an_alias_is_judged_on_the_index_it_shares(tmp_path):
    # A second mount of one driver shares the first mount's store, so the
    # workspace index it would otherwise be given is not the one it runs.
    disk = DiskVFS(root=str(tmp_path))
    ws = Workspace(
        {"/a": Mount(disk, index=IndexConfig(ttl=600))},
        index=IndexConfig(ttl=0),
    )
    try:
        ws.add_mount("/b", disk, read=FRESH)
        assert ws._registry.mount_for_prefix("/b/").read.policy is (
            ReadPolicy.FRESH
        )
    finally:
        await ws.close()


def test_fresh_is_refused_on_dev_which_keeps_no_listing():
    with pytest.raises(ValueError, match="caches reads or listings"):
        check_read_capability("/dev/", DevVFS(), FRESH)


def test_a_bad_bound_is_named_before_the_listing_verdict():
    with pytest.raises(ValueError, match="ttl must be at least 1 second"):
        check_read_capability(
            "/d/", RAMVFS(), ReadSpec(policy=ReadPolicy.FRESH, ttl=0)
        )


def test_the_revalidatable_roster_is_exactly_these_backends():
    declared = set()
    for name in known_vfs_names():
        entry = REGISTRY.get(name)
        if entry is None:
            continue
        if getattr(load_attr(entry.vfs_path), "read_revalidatable", False):
            declared.add(name)
    assert declared == REVALIDATABLE


def test_lancedb_decides_per_config_not_per_class():
    # The one backend whose `caches_reads` is an instance attribute: a
    # remote uri caches, a local path does not, so the two refusals differ
    # although the class is the same.
    local = LanceDBVFS(LanceDBConfig(uri="/tmp/lance"))
    assert local.caches_reads is False
    with pytest.raises(ValueError, match="caches reads or listings"):
        check_read_capability("/l/", local, FRESH)

    remote = LanceDBVFS(LanceDBConfig(uri="db://acme"))
    assert remote.caches_reads is True
    with pytest.raises(ValueError, match="comparable content token"):
        check_read_capability("/l/", remote, FRESH)


@pytest.mark.asyncio
async def test_constructor_alias_uses_first_mount_index():
    vfs = RAMVFS()
    ws = Workspace(
        {
            "/first": Mount(vfs, index=IndexConfig(ttl=600)),
            "/alias": Mount(vfs, index=IndexConfig(ttl=0), read=FRESH),
        }
    )
    try:
        assert ws.mount("/alias").index_store is ws.mount("/first").index_store
        assert ws.mount("/alias").index_store.ttl == 600
    finally:
        await ws.close()


def test_constructor_alias_cannot_enable_a_disabled_shared_index():
    vfs = RAMVFS()
    with pytest.raises(ValueError, match="caches reads or listings"):
        Workspace(
            {
                "/first": Mount(vfs, index=IndexConfig(ttl=0)),
                "/alias": Mount(vfs, index=IndexConfig(ttl=600), read=FRESH),
            }
        )
