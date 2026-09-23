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
import uuid

import pytest

from mirage.vfs.disk import DiskVFS
from mirage.vfs.ram import RAMVFS
from mirage.vfs.redis import RedisVFS
from mirage.vfs.s3 import S3VFS, S3Config

REDIS_URL = os.environ.get("REDIS_URL", "")

# ── RAM ────────────────────────────────────────────────────────────────


def test_ram_get_state_shape():
    p = RAMVFS()
    p._store.files["/a.txt"] = b"hello"
    p._store.dirs.add("/sub")
    state = p.get_state()
    assert state["type"] == "ram"
    assert "redacted_fields" not in state
    assert state["files"] == {"/a.txt": b"hello"}
    assert "/sub" in state["dirs"]


def test_ram_round_trip():
    src = RAMVFS()
    src._store.files["/a.txt"] = b"hello"
    src._store.files["/sub/b.txt"] = b"world"
    src._store.dirs.add("/sub")
    state = src.get_state()

    dst = RAMVFS()
    dst.load_state(state)
    assert dst._store.files == {"/a.txt": b"hello", "/sub/b.txt": b"world"}
    assert "/sub" in dst._store.dirs


# ── Disk ───────────────────────────────────────────────────────────────


def test_disk_get_state_walks_tree(tmp_path):
    root = tmp_path / "src"
    root.mkdir()
    (root / "a.txt").write_bytes(b"hello")
    (root / "sub").mkdir()
    (root / "sub" / "b.txt").write_bytes(b"world")
    p = DiskVFS(root=str(root))
    state = p.get_state()
    assert state["type"] == "disk"
    assert "redacted_fields" not in state
    assert state["files"] == {"a.txt": b"hello", "sub/b.txt": b"world"}


def test_disk_round_trip(tmp_path):
    src_root = tmp_path / "src"
    src_root.mkdir()
    (src_root / "a.txt").write_bytes(b"hello")
    (src_root / "sub").mkdir()
    (src_root / "sub" / "b.txt").write_bytes(b"world")
    state = DiskVFS(root=str(src_root)).get_state()

    dst_root = tmp_path / "dst"
    dst_root.mkdir()
    DiskVFS(root=str(dst_root)).load_state(state)
    assert (dst_root / "a.txt").read_bytes() == b"hello"
    assert (dst_root / "sub" / "b.txt").read_bytes() == b"world"


# ── Redis ──────────────────────────────────────────────────────────────


@pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")
def test_redis_round_trip():
    import redis as sync_redis
    src_prefix = f"mirage:test:src:{uuid.uuid4().hex}:"
    dst_prefix = f"mirage:test:dst:{uuid.uuid4().hex}:"
    src = RedisVFS(url=REDIS_URL, key_prefix=src_prefix)
    dst = RedisVFS(url=REDIS_URL, key_prefix=dst_prefix)

    sc = sync_redis.Redis.from_url(REDIS_URL)
    sc.set(f"{src_prefix}file:/a.txt", b"hello")
    sc.set(f"{src_prefix}file:/sub/b.txt", b"world")
    sc.sadd(f"{src_prefix}dir", "/sub")
    sc.close()

    state = src.get_state()
    assert state["type"] == "redis"
    assert state["config"]["url"] == "<REDACTED>"
    assert state["config"]["key_prefix"] == src_prefix
    assert state["files"] == {"/a.txt": b"hello", "/sub/b.txt": b"world"}
    assert "/sub" in state["dirs"]

    dst.load_state(state)

    sc = sync_redis.Redis.from_url(REDIS_URL)
    try:
        assert sc.get(f"{dst_prefix}file:/a.txt") == b"hello"
        assert sc.get(f"{dst_prefix}file:/sub/b.txt") == b"world"
        assert sc.sismember(f"{dst_prefix}dir", "/sub")
    finally:
        # Cleanup
        for prefix in (src_prefix, dst_prefix):
            for key in sc.scan_iter(f"{prefix}*"):
                sc.delete(key)
        sc.close()


# ── S3 ─────────────────────────────────────────────────────────────────


def test_s3_get_state_redacts_creds():
    cfg = S3Config(
        bucket="my-bucket",
        region="us-east-1",
        aws_access_key_id="AKIA-REAL-KEY-FOR-TEST",
        aws_secret_access_key="REAL-SECRET-KEY-CHARS",
    )
    p = S3VFS(cfg)
    state = p.get_state()
    assert state["type"] == "s3"
    assert state["config"]["bucket"] == "my-bucket"
    assert state["config"]["aws_access_key_id"] == "<REDACTED>"
    assert state["config"]["aws_secret_access_key"] == "<REDACTED>"
    assert "redacted_fields" not in state


def test_s3_no_real_creds_in_state():
    secret = "TOPSECRET-VALUE-XYZ"
    cfg = S3Config(
        bucket="b",
        region="us-east-1",
        aws_access_key_id="AKIA-OBVIOUS",
        aws_secret_access_key=secret,
    )
    state = S3VFS(cfg).get_state()
    blob = repr(state)
    assert secret not in blob
    assert "AKIA-OBVIOUS" not in blob
    assert "<REDACTED>" in blob


def test_s3_get_state_without_inline_creds_has_no_redactions():
    cfg = S3Config(bucket="b", region="us-east-1", aws_profile="dev")
    state = S3VFS(cfg).get_state()
    assert "<REDACTED>" not in repr(state)
    assert "redacted_fields" not in state
    assert state["config"]["aws_profile"] == "dev"


def test_s3_load_state_is_noop():
    cfg = S3Config(bucket="b", region="us-east-1")
    p = S3VFS(cfg)
    p.load_state({"some": "state"})


# ── all remote/token VFS: cred redaction matrix ──────────────────


def _build(mod_path, cls_name, cfg_cls_name, **cfg_kwargs):
    import importlib
    mod = importlib.import_module(mod_path)
    cfg = getattr(mod, cfg_cls_name)(**cfg_kwargs)
    return getattr(mod, cls_name)(cfg)


REDACTION_CASES = [
    ("mirage.vfs.r2", "R2VFS", "R2Config",
     dict(bucket="b",
          account_id="acc",
          access_key_id="AKIA-R2-LEAK",
          secret_access_key="R2-SECRET-LEAK"),
     ["AKIA-R2-LEAK", "R2-SECRET-LEAK"]),
    ("mirage.vfs.oci", "OCIVFS", "OCIConfig",
     dict(bucket="b",
          namespace="ns",
          region="us-ashburn-1",
          access_key_id="OCI-AKIA-LEAK",
          secret_access_key="OCI-SECRET-LEAK"),
     ["OCI-AKIA-LEAK", "OCI-SECRET-LEAK"]),
    ("mirage.vfs.supabase", "SupabaseVFS", "SupabaseConfig",
     dict(bucket="b",
          region="us-east-1",
          project_ref="ref",
          access_key_id="SUPA-AKIA-LEAK",
          secret_access_key="SUPA-SECRET-LEAK",
          session_token="SUPA-TOKEN-LEAK"),
     ["SUPA-AKIA-LEAK", "SUPA-SECRET-LEAK", "SUPA-TOKEN-LEAK"]),
    ("mirage.vfs.gcs", "GCSVFS", "GCSConfig",
     dict(bucket="b",
          access_key_id="GCS-AKIA-LEAK",
          secret_access_key="GCS-SECRET-LEAK"),
     ["GCS-AKIA-LEAK", "GCS-SECRET-LEAK"]),
    ("mirage.vfs.gdrive", "GoogleDriveVFS", "GoogleDriveConfig",
     dict(client_id="id",
          client_secret="GD-SECRET-LEAK",
          refresh_token="GD-REFRESH-LEAK"),
     ["GD-SECRET-LEAK", "GD-REFRESH-LEAK"]),
    ("mirage.vfs.gmail", "GmailVFS", "GmailConfig",
     dict(client_id="id",
          client_secret="GM-SECRET-LEAK",
          refresh_token="GM-REFRESH-LEAK"),
     ["GM-SECRET-LEAK", "GM-REFRESH-LEAK"]),
    ("mirage.vfs.gdocs", "GDocsVFS", "GDocsConfig",
     dict(client_id="id",
          client_secret="GDOC-SECRET-LEAK",
          refresh_token="GDOC-REFRESH-LEAK"),
     ["GDOC-SECRET-LEAK", "GDOC-REFRESH-LEAK"]),
    ("mirage.vfs.gsheets", "GSheetsVFS", "GSheetsConfig",
     dict(client_id="id",
          client_secret="GSH-SECRET-LEAK",
          refresh_token="GSH-REFRESH-LEAK"),
     ["GSH-SECRET-LEAK", "GSH-REFRESH-LEAK"]),
    ("mirage.vfs.gslides", "GSlidesVFS", "GSlidesConfig",
     dict(client_id="id",
          client_secret="GSL-SECRET-LEAK",
          refresh_token="GSL-REFRESH-LEAK"),
     ["GSL-SECRET-LEAK", "GSL-REFRESH-LEAK"]),
    ("mirage.vfs.slack", "SlackVFS", "SlackConfig",
     dict(token="SLACK-TOKEN-LEAK", search_token="SLACK-SEARCH-LEAK"),
     ["SLACK-TOKEN-LEAK", "SLACK-SEARCH-LEAK"]),
    ("mirage.vfs.discord", "DiscordVFS", "DiscordConfig",
     dict(token="DISCORD-TOKEN-LEAK"), ["DISCORD-TOKEN-LEAK"]),
    ("mirage.vfs.notion", "NotionVFS", "NotionConfig",
     dict(api_key="NOTION-KEY-LEAK"), ["NOTION-KEY-LEAK"]),
    ("mirage.vfs.linear", "LinearVFS", "LinearConfig",
     dict(api_key="LINEAR-KEY-LEAK"), ["LINEAR-KEY-LEAK"]),
    ("mirage.vfs.trello", "TrelloVFS", "TrelloConfig",
     dict(api_key="TRELLO-KEY-LEAK", api_token="TRELLO-TOKEN-LEAK"),
     ["TRELLO-KEY-LEAK", "TRELLO-TOKEN-LEAK"]),
    ("mirage.vfs.email", "EmailVFS", "EmailConfig",
     dict(imap_host="h",
          smtp_host="h",
          username="u",
          password="EMAIL-PWD-LEAK"), ["EMAIL-PWD-LEAK"]),
    ("mirage.vfs.langfuse", "LangfuseVFS", "LangfuseConfig",
     dict(public_key="LF-PUB",
          secret_key="LF-SECRET-LEAK"), ["LF-SECRET-LEAK"]),
    ("mirage.vfs.mongodb", "MongoDBVFS", "MongoDBConfig",
     dict(uri="mongodb://user:pwd@h:27017/db"),
     ["mongodb://user:pwd@h:27017/db"]),
]


@pytest.mark.parametrize("mod,cls,cfg_cls,kwargs,leaks",
                         REDACTION_CASES,
                         ids=[c[1] for c in REDACTION_CASES])
def test_vfs_get_state_redacts(mod, cls, cfg_cls, kwargs, leaks):
    p = _build(mod, cls, cfg_cls, **kwargs)
    state = p.get_state()
    assert "redacted_fields" not in state
    blob = repr(state)
    for leaked in leaks:
        assert leaked not in blob, (f"{cls}: leaked {leaked!r} in state")
    assert "<REDACTED>" in blob


def test_github_vfs_get_state_redacts():
    from mirage.vfs.github import GitHubConfig, GitHubVFS

    # No fetch to stub: the constructor takes the tree, so building one
    # for a state check costs nothing.
    cfg = GitHubConfig(token="GH-TOKEN-LEAK")
    p = GitHubVFS(cfg, "o", "r", "main", "main", {})
    state = p.get_state()
    assert state["config"]["token"] == "<REDACTED>"
    assert "redacted_fields" not in state
    blob = repr(state)
    assert "GH-TOKEN-LEAK" not in blob
    assert "<REDACTED>" in blob
    assert state["owner"] == "o"
    assert state["repo"] == "r"
    assert state["ref"] == "main"


def test_ssh_no_redaction_no_override():
    from mirage.vfs.ssh import SSHVFS, SSHConfig
    cfg = SSHConfig(host="example.com", username="me")
    p = SSHVFS(cfg)
    state = p.get_state()
    assert "redacted_fields" not in state
    assert "<REDACTED>" not in repr(state)
    # Plain config preserved
    assert state["config"]["host"] == "example.com"
    assert state["config"]["username"] == "me"


# ── database-backed VFS, built through the registry ──────────────

# The matrix above names classes directly; this one goes through
# build_vfs, the path a mount actually takes, so a backend that is
# registry-mountable but carries no state is caught. `secret` is stated
# outright rather than sniffed: postgres and mongodb bury the password
# inside a DSN, so no string-shape heuristic finds it. Twin of the
# TypeScript sweep in packages/node/src/vfs/state_round_trip.test.ts.
DB_STATE_CASES = [
    ("postgres", dict(dsn="postgresql://u:PGSECRET@localhost:5432/db"),
     "PGSECRET"),
    ("mongodb", dict(uri="mongodb://u:MONGOSECRET@localhost:27017/db"),
     "MONGOSECRET"),
    ("lancedb", dict(uri="db://x", api_key="LANCESECRET"), "LANCESECRET"),
    ("qdrant", dict(collection="c", api_key="QDRANTSECRET"), "QDRANTSECRET"),
    # No credential at all. `_walk_config_dump` skips a None secret, so the
    # field stays null rather than becoming "<REDACTED>" — a planted marker
    # would claim a credential had been dropped from a snapshot that never
    # held one. The TypeScript redactors mirror this.
    ("lancedb", dict(uri="db://x"), None),
    ("qdrant", dict(collection="c"), None),
    ("dify", dict(api_key="DIFYSECRET", base_url="http://x",
                  dataset_id="d"), "DIFYSECRET"),
    # chroma reaches its server with no credential at all.
    ("chroma", dict(collection_name="c"), None),
]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "name,config,secret",
    DB_STATE_CASES,
    ids=[f"{c[0]}-{'secret' if c[2] else 'nocreds'}" for c in DB_STATE_CASES])
async def test_registry_vfs_state_masks_credential(name, config, secret):
    from mirage.vfs.registry import build_vfs
    from mirage.vfs.secrets import has_redacted_secret

    p = build_vfs(name, config)
    state = p.get_state()
    assert state["type"] == name
    assert state["config"] is not None

    blob = repr(state)
    if secret is not None:
        # The credential must not survive into the snapshot, and the marker
        # it leaves behind is what makes load demand a fresh one.
        assert secret not in blob, f"{name}: leaked {secret!r} in state"
        assert "<REDACTED>" in blob
        assert has_redacted_secret(state["config"])
    else:
        assert not has_redacted_secret(state["config"])
        # An absent secret stays absent. `_walk_config_dump` skips None, so
        # the field is null rather than "<REDACTED>", and load does not
        # demand a fresh config for a snapshot that never held a credential.
        if "api_key" in state["config"]:
            assert state["config"]["api_key"] is None

    p.load_state(state)
    await p.close()
