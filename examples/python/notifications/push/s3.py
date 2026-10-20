import asyncio
import json
import os
import sys
from pathlib import Path

import aiofiles

from mirage import Workspace
from mirage.core.s3.events import S3EventHook
from mirage.types import PathSpec
from mirage.vfs.s3 import S3VFS, S3Config


async def main() -> None:
    async with aiofiles.open(Path(sys.argv[1])) as source:
        payload = json.loads(await source.read())
    vfs = S3VFS(S3Config(bucket=os.environ["S3_BUCKET"]))
    ws = Workspace({"/s3": vfs})
    hook = S3EventHook(vfs.accessor)
    root = PathSpec.from_str_path("/s3", "")
    try:
        for record in payload["Records"]:
            for change in await hook.to_events(
                root, record["eventName"], record
            ):
                await ws.notify(change)
                print(f"{change.kind.value}: {change.path.virtual}")
    finally:
        await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
