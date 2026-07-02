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

import asyncio
import logging
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import aiobotocore.client
import boto3
import moto.s3.models as _s3_models
from cases import run_not_found, run_provision_cache_cases
from moto.server import ThreadedMotoServer

from mirage import MountMode, Workspace
from mirage.accessor.s3 import S3Accessor
from mirage.commands import safeguard as _safeguard
from mirage.resource.gcs import GCSConfig, GCSResource
from mirage.resource.minio import MinIOConfig, MinIOResource
from mirage.resource.s3 import S3Config, S3Resource
from mirage.resource.seaweedfs import SeaweedFSConfig, SeaweedFSResource
from mirage.types import CommandSafeguard, ConsistencyPolicy

# Freeze the timestamp moto stamps onto every object so LastModified (and thus
# the `ls -l` mtime column resolved from the index) is deterministic.
_FROZEN_MTIME = datetime(2026, 3, 31, 12, 0, 0, tzinfo=timezone.utc)
_s3_models.utcnow = lambda: _FROZEN_MTIME

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
SEED_OBJECTS = [
    "example.jsonl", "example.json", "example.parquet", "example.orc",
    "example.feather"
]
S3_BUCKET = "mirage-integ-s3"
GCS_BUCKET = "mirage-integ-gcs"
MINIO_BUCKET = "mirage-integ-minio"
SEAWEEDFS_BUCKET = "mirage-integ-seaweedfs"
MOUNTS = ["/s3", "/gcs", "/minio", "/seaweedfs"]
CREDS = dict(aws_access_key_id="testing",
             aws_secret_access_key="testing",
             region_name="us-east-1")

# Count backend API calls so the index fast-path is observable: readdir issues
# one ListObjectsV2 and populates the index, after which per-entry stat
# resolves from the index with zero HeadObject calls. A regression that stops
# threading index would show up here as HeadObject calls.
API_CALLS: Counter = Counter()
_orig_make_api_call = aiobotocore.client.AioBaseClient._make_api_call


async def _counting_make_api_call(self, operation_name, api_params):
    API_CALLS[operation_name] += 1
    return await _orig_make_api_call(self, operation_name, api_params)


aiobotocore.client.AioBaseClient._make_api_call = _counting_make_api_call

# Read-only, deterministic commands drawn from examples/python/s3/s3.py and
# examples/python/gcs/gcs.py. {m} is the mount root (/s3 or /gcs) and the same
# list runs against both, so identical output across mounts also proves parity.
PER_MOUNT_CASES: list[tuple[str, str]] = [
    ("ls", "ls {m}/"),
    ("ls_data", "ls {m}/data/"),
    ("tree", "tree {m}/"),
    ("stat", "stat -c '%s %n' {m}/data/example.json"),
    ("cat_head", "cat {m}/data/example.json | head -n 5"),
    ("head_1_jsonl", "head -n 1 {m}/data/example.jsonl"),
    ("head_3_jsonl", "head -n 3 {m}/data/example.jsonl"),
    ("tail_2_jsonl", "tail -n 2 {m}/data/example.jsonl"),
    ("wc_l_jsonl", "wc -l {m}/data/example.jsonl"),
    ("wc_c_json", "wc -c {m}/data/example.json"),
    ("grep_c_mirage", "grep -c mirage {m}/data/example.jsonl"),
    ("grep_m1_mirage", "grep -m 1 mirage {m}/data/example.jsonl"),
    ("grep_head", "grep mirage {m}/data/example.jsonl | head -n 3"),
    ("grep_queue_wc", "grep queue-operation {m}/data/example.jsonl | wc -l"),
    ("grep_rl_item", "grep -rl item {m}/data/"),
    ("rg_l_item", "rg -l item {m}/data/"),
    ("grep_rc_mirage", "grep -rc mirage {m}/data/"),
    ("grep_item_parquet", "grep item_5 {m}/data/example.parquet"),
    ("rg_item_glob_feather", "rg item_5 {m}/data/*.feather"),
    ("ls_glob_parquet", "ls {m}/data/*.parquet"),
    ("ls_file_json", "ls {m}/data/example.json"),
    ("find_json", "find {m}/ -name '*.json'"),
    ("find_type_f", "find {m}/data -type f | sort"),
    ("jq_version", "jq .metadata.version {m}/data/example.json"),
    ("jq_team_names",
     "jq '.departments[].teams[].name' {m}/data/example.json"),
    ("pipe_sort_uniq_wc", "cat {m}/data/example.jsonl"
     " | grep queue-operation | sort | uniq | wc -l"),
    ("pipe_sort_uniq_w0_wc", "cat {m}/data/example.jsonl"
     " | grep queue-operation | sort | uniq -w 0 | wc -l"),
    ("pipe_sort_uniq_f_wc", "cat {m}/data/example.jsonl"
     " | grep queue-operation | sort | uniq -f 1 | wc -l"),
    ("md5_json", "md5 {m}/data/example.json"),
    ("sha256_json", "sha256sum {m}/data/example.json"),
    ("ls_l_data", "ls -l {m}/data/"),
    ("file_parquet", "file {m}/data/example.parquet"),
    ("file_orc", "file {m}/data/example.orc"),
    ("file_feather", "file {m}/data/example.feather"),
    ("du_multi", "du {m}/data/example.json {m}/data/example.jsonl"),
    ("file_multi", "file {m}/data/example.json {m}/data/example.jsonl"),

    # ----- safeguard: per-mount cap on cat (set to 20 lines below) -----
    ("safeguard_cat_truncates", "cat {m}/data/example.jsonl"),
    ("safeguard_cat_pipe_uncapped", "cat {m}/data/example.jsonl | wc -l"),
]

# Cross-mount fingerprints mirroring examples/python/cross/example.py: read the
# same logical object from two independent buckets and concatenate across them.
CROSS_CASES: list[tuple[str, str]] = [
    ("head1_s3", "head -n 1 /s3/data/example.jsonl"),
    ("head1_gcs", "head -n 1 /gcs/data/example.jsonl"),
    ("wc_s3", "cat /s3/data/example.jsonl | wc -l"),
    ("wc_gcs", "cat /gcs/data/example.jsonl | wc -l"),
    ("grep_s3", "grep -c mirage /s3/data/example.jsonl"),
    ("grep_gcs", "grep -c mirage /gcs/data/example.jsonl"),
    ("concat_wc",
     "cat /s3/data/example.jsonl /gcs/data/example.jsonl | wc -l"),
]

# Streaming byte accounting mirroring examples/python/gcs/gcs.py: clear the
# cache, run, and report bytes pulled from the backend. Early-exit commands
# transfer far less than the full object, and the count is identical across
# both mounts (parity). Timing is omitted so output stays deterministic.
STREAMING_CASES: list[tuple[str, str]] = [
    ("head_c100", "head -c 100 {m}/data/example.jsonl"),
    ("head_n1", "head -n 1 {m}/data/example.jsonl"),
    ("grep_m1", "grep -m 1 mirage {m}/data/example.jsonl"),
    ("cat_wc_full", "cat {m}/data/example.jsonl | wc -l"),
]

# Warm-read serving: a cat warms the file cache for the object, then each
# read-only command reads the same object and is served entirely from cache,
# pulling zero backend bytes. cat goes through the generic read-through and
# grep/head/tail/wc through the shared consumers; a regression that stopped
# serving warm reads would re-fetch the object and bytes would jump above 0.
WARM_SERVE_CASES: list[tuple[str, str]] = [
    ("warm_cat", "cat {m}/data/example.jsonl"),
    ("warm_grep", "grep mirage {m}/data/example.jsonl"),
    ("warm_head", "head -n 1 {m}/data/example.jsonl"),
    ("warm_tail", "tail -n 1 {m}/data/example.jsonl"),
    ("warm_wc", "wc -l {m}/data/example.jsonl"),
]

# Index fast-path accounting: run from a fresh workspace (empty index) and
# count backend API calls. readdir populates the index, so per-entry stat
# issues zero HeadObject calls. GetObject reads are dropped from the report so
# the assertion focuses on the stat/list pattern the index governs.
INDEX_CASES: list[tuple[str, str]] = [
    ("ls_l", "ls -l {m}/data/"),
    ("tree", "tree {m}/"),
]

# Lazy exit codes survive the timeout/safeguard stream wrap on streaming
# backends: grep resolves its exit code only after the object is consumed, so
# wrapping stdout with a timeout must not clobber the final exit code.
EXIT_CODE_CASES: list[tuple[str, str]] = [
    ("grep_match", "grep -q mirage {m}/data/example.jsonl"),
    ("grep_no_match", "grep -q zzzznomatch {m}/data/example.jsonl"),
]

# Deterministic timeout surface: a per-mount sub-second timeout on sleep makes
# the command exit 124 with attributed stderr, end-to-end through the runner.
TIMEOUT_CASES: list[tuple[str, str]] = [
    ("timeout_sleep_fires", "sleep 2"),
]


def _seed(endpoint: str) -> None:
    client = boto3.client("s3", endpoint_url=endpoint, **CREDS)
    for bucket in (S3_BUCKET, GCS_BUCKET, MINIO_BUCKET, SEAWEEDFS_BUCKET):
        client.create_bucket(Bucket=bucket)
        for obj in SEED_OBJECTS:
            client.put_object(Bucket=bucket,
                              Key=f"data/{obj}",
                              Body=(DATA_DIR / obj).read_bytes())


def _build_workspace(
        endpoint: str,
        consistency: ConsistencyPolicy = ConsistencyPolicy.LAZY) -> Workspace:
    s3 = S3Resource(
        S3Config(bucket=S3_BUCKET,
                 region="us-east-1",
                 endpoint_url=endpoint,
                 aws_access_key_id="testing",
                 aws_secret_access_key="testing",
                 path_style=True))
    gcs = GCSResource(
        GCSConfig(bucket=GCS_BUCKET,
                  endpoint_url=endpoint,
                  access_key_id="testing",
                  secret_access_key="testing"))
    # moto serves an IP endpoint, so the S3-compatible GCS client must use
    # path-style addressing (bucket.127.0.0.1 is not resolvable).
    gcs.config = gcs.config.model_copy(update={"path_style": True})
    gcs.accessor = S3Accessor(gcs.config)
    minio = MinIOResource(
        MinIOConfig(bucket=MINIO_BUCKET,
                    endpoint_url=endpoint,
                    access_key_id="testing",
                    secret_access_key="testing",
                    path_style=True))
    seaweedfs = SeaweedFSResource(
        SeaweedFSConfig(bucket=SEAWEEDFS_BUCKET,
                        endpoint_url=endpoint,
                        access_key_id="testing",
                        secret_access_key="testing",
                        path_style=True))
    return Workspace(
        {
            "/s3/": s3,
            "/gcs/": gcs,
            "/minio/": minio,
            "/seaweedfs/": seaweedfs
        },
        mode=MountMode.READ,
        consistency=consistency)


async def _run(ws: Workspace, name: str, cmd: str) -> None:
    result = await ws.execute(cmd)
    out = await result.stdout_str()
    print(f"=== {name} ===")
    print(out, end="" if out.endswith("\n") else "\n")
    if "safeguard_" in name:
        err = await result.stderr_str()
        if err:
            print(err, end="" if err.endswith("\n") else "\n")


async def _run_exit(ws: Workspace, name: str, cmd: str) -> None:
    result = await ws.execute(cmd)
    err = await result.stderr_str()
    print(f"=== {name} ===")
    print(f"exit={result.exit_code}")
    if err:
        print(err, end="" if err.endswith("\n") else "\n")


def _set_cat_safeguard(ws: Workspace, max_lines: int) -> None:
    sg = CommandSafeguard(max_lines=max_lines)
    mounts = list(ws._registry._mounts)
    for m in mounts:
        m.command_safeguards["cat"] = sg


async def _measure(ws: Workspace, name: str, cmd: str) -> None:
    await ws.cache.clear()
    before = sum(rec.bytes for rec in ws.ops.records)
    result = await ws.execute(cmd)
    out = await result.stdout_str()
    net = sum(rec.bytes for rec in ws.ops.records) - before
    lines = out.strip().splitlines()
    first = lines[0][:48] if lines else ""
    print(f"=== {name} ===")
    print(f"bytes={net} lines={len(lines)} out0={first!r}")


async def _warm_serve(endpoint: str, name: str, mount: str, cmd: str) -> None:
    ws = _build_workspace(endpoint)
    await (await ws.execute(f"cat {mount}/data/example.jsonl")).stdout_str()
    before = sum(rec.bytes for rec in ws.ops.records)
    await (await ws.execute(cmd)).stdout_str()
    net = sum(rec.bytes for rec in ws.ops.records) - before
    print(f"=== {name} ===")
    print(f"bytes={net} served_from_cache={net == 0}")


async def _measure_calls(endpoint: str, name: str, cmd: str) -> None:
    ws = _build_workspace(endpoint)
    API_CALLS.clear()
    await ws.execute(cmd)
    lists = API_CALLS.get("ListObjectsV2", 0)
    heads = API_CALLS.get("HeadObject", 0)
    print(f"=== {name} ===")
    print(f"ListObjectsV2={lists} HeadObject={heads}")


# Cache consistency: read once (caches v1), mutate the object out-of-band via
# the raw SDK (new ETag), then read again. ALWAYS stats the backend and evicts
# the stale cache entry on every read so the second read returns v2; LAZY keeps
# serving the cached v1. A fresh single-purpose key is used and only cat
# (no ls) touches it, so stat hits HeadObject and carries the ETag fingerprint.
async def _run_consistency(endpoint: str) -> None:
    client = boto3.client("s3", endpoint_url=endpoint, **CREDS)
    key = "data/consistency.txt"
    for policy, label in ((ConsistencyPolicy.ALWAYS, "always"),
                          (ConsistencyPolicy.LAZY, "lazy")):
        client.put_object(Bucket=S3_BUCKET, Key=key, Body=b"v1")
        ws = _build_workspace(endpoint, consistency=policy)
        first = await (
            await ws.execute("cat /s3/data/consistency.txt")).stdout_str()
        print(f"=== consistency:{label}:first ===")
        print(first, end="" if first.endswith("\n") else "\n")
        client.put_object(Bucket=S3_BUCKET, Key=key, Body=b"v2")
        second = await (
            await ws.execute("cat /s3/data/consistency.txt")).stdout_str()
        print(f"=== consistency:{label}:second ===")
        print(second, end="" if second.endswith("\n") else "\n")


# In-band coherence: under LAZY (which never revalidates on its own), each
# mutation done through a mirage command must invalidate the parent listing at
# the write site, so a previously cached `ls` reflects it. cp -> core copy and
# rm -r -> core rm_r: each caches the listing with ls, mutates in-band, then
# lists again and must see fresh state. Verified to go stale when the copy/rm
# hook is removed; the gzip case only covers the write/unlink hooks.
async def _run_coherence(endpoint: str) -> None:
    s3 = S3Resource(
        S3Config(bucket=S3_BUCKET,
                 region="us-east-1",
                 endpoint_url=endpoint,
                 aws_access_key_id="testing",
                 aws_secret_access_key="testing",
                 path_style=True))
    ws = Workspace({"/s3/": s3},
                   mode=MountMode.WRITE,
                   consistency=ConsistencyPolicy.LAZY)
    await ws.execute("mkdir -p /s3/coh"
                     " && echo one | tee /s3/coh/a.txt > /dev/null")
    await _run(ws, "coherence:seed_ls", "ls /s3/coh")
    await ws.execute("cp /s3/coh/a.txt /s3/coh/b.txt")
    await _run(ws, "coherence:after_cp_ls", "ls /s3/coh")
    await ws.execute("mkdir -p /s3/coh/sub"
                     " && echo z | tee /s3/coh/sub/z.txt > /dev/null")
    await _run(ws, "coherence:after_mkdir_ls", "ls /s3/coh")
    await ws.execute("rm -r /s3/coh/sub")
    await _run(ws, "coherence:after_rmr_ls", "ls /s3/coh")


async def main() -> None:
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    endpoint = f"http://{host}:{port}"
    try:
        _seed(endpoint)
        ws = _build_workspace(endpoint)
        _set_cat_safeguard(ws, max_lines=20)
        for mount in MOUNTS:
            tag = mount.lstrip("/")
            for name, tmpl in PER_MOUNT_CASES:
                await _run(ws, f"{tag}:{name}", tmpl.format(m=mount))
        for name, cmd in CROSS_CASES:
            await _run(ws, f"cross:{name}", cmd)
        for mount in MOUNTS:
            tag = mount.lstrip("/")
            for name, tmpl in STREAMING_CASES:
                await _measure(ws, f"{tag}:stream:{name}",
                               tmpl.format(m=mount))
        for mount in MOUNTS:
            tag = mount.lstrip("/")
            for name, tmpl in WARM_SERVE_CASES:
                await _warm_serve(endpoint, f"{tag}:warm:{name}", mount,
                                  tmpl.format(m=mount))
        for mount in MOUNTS:
            tag = mount.lstrip("/")
            for name, tmpl in INDEX_CASES:
                await _measure_calls(endpoint, f"{tag}:calls:{name}",
                                     tmpl.format(m=mount))
        for mount in MOUNTS:
            tag = mount.lstrip("/")
            for name, tmpl in EXIT_CODE_CASES:
                await _run_exit(ws, f"{tag}:exit:{name}", tmpl.format(m=mount))
        prev_sleep = _safeguard.DEFAULT_COMMAND_SAFEGUARDS.get("sleep")
        _safeguard.DEFAULT_COMMAND_SAFEGUARDS["sleep"] = CommandSafeguard(
            timeout_seconds=0.1)
        try:
            for name, cmd in TIMEOUT_CASES:
                await _run_exit(ws, f"safeguard:{name}", cmd)
        finally:
            if prev_sleep is None:
                _safeguard.DEFAULT_COMMAND_SAFEGUARDS.pop("sleep", None)
            else:
                _safeguard.DEFAULT_COMMAND_SAFEGUARDS["sleep"] = prev_sleep
        await run_not_found(ws, MOUNTS[0])
        # The suite workspace is read-only; the cache-flip probe seeds its
        # own files, so it gets a write-mode mount on the same bucket.
        ws_write = Workspace(
            {
                "/s3":
                S3Resource(
                    S3Config(bucket=S3_BUCKET,
                             region="us-east-1",
                             endpoint_url=endpoint,
                             aws_access_key_id="testing",
                             aws_secret_access_key="testing",
                             path_style=True))
            },
            mode=MountMode.WRITE)
        await run_provision_cache_cases(ws_write, "/s3")
        await _run_consistency(endpoint)
        await _run_coherence(endpoint)
    finally:
        server.stop()


if __name__ == "__main__":
    asyncio.run(main())
