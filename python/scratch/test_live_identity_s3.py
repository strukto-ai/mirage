import asyncio
import os

from mirage import MountMode, Workspace
from mirage.resource.s3 import S3Config, S3Resource

PATH = "/s3/mirage-pr-demo/file.txt"


async def main() -> None:
    config = S3Config(
        bucket=os.environ["AWS_S3_BUCKET"],
        region=os.environ["AWS_DEFAULT_REGION"],
        aws_profile=os.environ.get("AWS_PROFILE"),
    )
    ws = Workspace(
        {"/s3/": S3Resource(config)},
        mode=MountMode.WRITE,
    )

    try:
        identity = await ws.ops.live_identity(PATH)
        print("live_identity:", identity)

        data, read_identity = await ws.ops.read_with_identity(PATH)
        print("content:", data.decode().strip())
        print("read_identity:", read_identity)
    finally:
        await ws.close()


asyncio.run(main())
