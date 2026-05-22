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
from pathlib import Path

import boto3
from moto.server import ThreadedMotoServer

from mirage import MountMode, Workspace
from mirage.accessor.s3 import S3Accessor
from mirage.resource.gcs import GCSConfig, GCSResource
from mirage.resource.s3 import S3Config, S3Resource

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
SEED_OBJECTS = ["example.jsonl", "example.json"]
S3_BUCKET = "mirage-integ-s3"
GCS_BUCKET = "mirage-integ-gcs"
CREDS = dict(aws_access_key_id="testing",
             aws_secret_access_key="testing",
             region_name="us-east-1")

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
    ("find_json", "find {m}/ -name '*.json'"),
    ("find_type_f", "find {m}/data -type f | sort"),
    ("jq_version", "jq .metadata.version {m}/data/example.json"),
    ("jq_team_names",
     "jq '.departments[].teams[].name' {m}/data/example.json"),
    ("pipe_sort_uniq_wc", "cat {m}/data/example.jsonl"
     " | grep queue-operation | sort | uniq | wc -l"),
    ("md5_json", "md5 {m}/data/example.json"),
    ("sha256_json", "sha256sum {m}/data/example.json"),
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


def _seed(endpoint: str) -> None:
    client = boto3.client("s3", endpoint_url=endpoint, **CREDS)
    for bucket in (S3_BUCKET, GCS_BUCKET):
        client.create_bucket(Bucket=bucket)
        for obj in SEED_OBJECTS:
            client.put_object(Bucket=bucket,
                              Key=f"data/{obj}",
                              Body=(DATA_DIR / obj).read_bytes())


def _build_workspace(endpoint: str) -> Workspace:
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
    return Workspace({"/s3/": s3, "/gcs/": gcs}, mode=MountMode.READ)


async def _run(ws: Workspace, name: str, cmd: str) -> None:
    result = await ws.execute(cmd)
    out = await result.stdout_str()
    print(f"=== {name} ===")
    print(out, end="" if out.endswith("\n") else "\n")


async def main() -> None:
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    endpoint = f"http://{host}:{port}"
    try:
        _seed(endpoint)
        ws = _build_workspace(endpoint)
        for name, tmpl in PER_MOUNT_CASES:
            await _run(ws, f"s3:{name}", tmpl.format(m="/s3"))
        for name, tmpl in PER_MOUNT_CASES:
            await _run(ws, f"gcs:{name}", tmpl.format(m="/gcs"))
        for name, cmd in CROSS_CASES:
            await _run(ws, f"cross:{name}", cmd)
    finally:
        server.stop()


if __name__ == "__main__":
    asyncio.run(main())
