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
import sys
from pathlib import Path

import boto3
from moto.server import ThreadedMotoServer

sys.path.insert(0, str(Path(__file__).parent))

from cases import run_cases  # noqa: E402

from mirage import MountMode, Workspace  # noqa: E402
from mirage.resource.s3 import S3Config, S3Resource  # noqa: E402

BUCKET = "mirage-integ-s3-cases"
BUCKET2 = "mirage-integ-s3-cases-xm"
CREDS = dict(aws_access_key_id="testing",
             aws_secret_access_key="testing",
             region_name="us-east-1")


async def main() -> None:
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    endpoint = f"http://{host}:{port}"
    try:
        client = boto3.client("s3", endpoint_url=endpoint, **CREDS)
        client.create_bucket(Bucket=BUCKET)
        client.create_bucket(Bucket=BUCKET2)
        s3 = S3Resource(
            S3Config(bucket=BUCKET,
                     region="us-east-1",
                     endpoint_url=endpoint,
                     aws_access_key_id="testing",
                     aws_secret_access_key="testing",
                     path_style=True))
        s3b = S3Resource(
            S3Config(bucket=BUCKET2,
                     region="us-east-1",
                     endpoint_url=endpoint,
                     aws_access_key_id="testing",
                     aws_secret_access_key="testing",
                     path_style=True))
        ws = Workspace({"/data": s3, "/data2": s3b}, mode=MountMode.WRITE)
        await run_cases(ws)
    finally:
        server.stop()


if __name__ == "__main__":
    asyncio.run(main())
