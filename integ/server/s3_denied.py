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

import argparse
import json
import logging
import threading
import urllib.request

import boto3
from moto.iam.access_control import S3IAMRequest
from moto.server import ThreadedMotoServer

REGION = "us-east-1"
BUCKET = "mirage-integ-denied"
OBJECTS = {
    "rd/a.txt": b"needle a\n",
    "rd/b.txt": b"needle b\n",
    "rd/c.txt": b"needle c\n",
}
DENIED = "rd/b.txt"
READER = "reader"


def enforce_iam(endpoint: str) -> None:
    """Have moto check every later request against IAM.

    Args:
        endpoint (str): the moto server's base URL.
    """
    request = urllib.request.Request(
        f"{endpoint}/moto-api/reset-auth",
        data=b"0",
        method="POST",
        headers={"Content-Type": "text/plain"},
    )
    with urllib.request.urlopen(request):
        pass


def seed(endpoint: str) -> dict[str, str]:
    """Seed a bucket and a reader refused one key, then enforce IAM.

    The reader may list the bucket and get the keys under rd/ but
    DENIED, so it lists DENIED like any key while HEAD and GET on it
    answer 403, as on AWS. A grant scoped to rd/* also refuses HEAD on
    the bare key rd, which a directory must survive. The objects go in
    here rather than through a mount, so no write leaves DENIED's bytes
    in a cache for a read to answer from.

    Args:
        endpoint (str): the moto server's base URL.

    Returns:
        dict[str, str]: the S3_DENIED_* variables a target mounts with;
        no secret, since no signature is checked (see main).
    """
    unsigned = {
        "endpoint_url": endpoint,
        "region_name": REGION,
        "aws_access_key_id": "seed",
        "aws_secret_access_key": "seed",
    }
    s3 = boto3.client("s3", **unsigned)
    s3.create_bucket(Bucket=BUCKET)
    for key, body in OBJECTS.items():
        s3.put_object(Bucket=BUCKET, Key=key, Body=body)
    iam = boto3.client("iam", **unsigned)
    iam.create_user(UserName=READER)
    iam.put_user_policy(
        UserName=READER,
        PolicyName="rd-but-denied",
        PolicyDocument=json.dumps(
            {
                "Version": "2012-10-17",
                "Statement": [
                    {
                        "Effect": "Allow",
                        "Action": "s3:ListBucket",
                        "Resource": f"arn:aws:s3:::{BUCKET}",
                    },
                    {
                        "Effect": "Allow",
                        "Action": "s3:GetObject",
                        "Resource": f"arn:aws:s3:::{BUCKET}/rd/*",
                    },
                    {
                        "Effect": "Deny",
                        "Action": "s3:GetObject",
                        "Resource": f"arn:aws:s3:::{BUCKET}/{DENIED}",
                    },
                ],
            }
        ),
    )
    key = iam.create_access_key(UserName=READER)["AccessKey"]
    enforce_iam(endpoint)
    return {
        "S3_DENIED_ENDPOINT": endpoint,
        "S3_DENIED_BUCKET": BUCKET,
        "S3_DENIED_ACCESS_KEY_ID": key["AccessKeyId"],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    # shortcut: moto re-encodes "/" in a signed query, so no signature is
    # checked and the reader's secret goes unread; once moto fixes it, drop
    # this and hand the secret out.
    S3IAMRequest.check_signature = lambda self: None
    server = ThreadedMotoServer(
        ip_address="127.0.0.1", port=args.port, verbose=False
    )
    server.start()
    host, port = server.get_host_and_port()
    for name, value in seed(f"http://{host}:{port}").items():
        print(f"{name}={value}", flush=True)
    threading.Event().wait()


if __name__ == "__main__":
    main()
