import asyncio
import json
import os
from pathlib import Path

from requests import request_checks

from mirage import MountMode, Workspace
from mirage.core.wandb.read import read, read_stream
from mirage.core.wandb.stat import stat
from mirage.types import PathSpec
from mirage.vfs.registry import build_vfs
from mirage.vfs.wandb import WandbConfig, WandbVFS


def path(key: str) -> PathSpec:
    return PathSpec.from_str_path("/wandb/" + key, vfs_path=key)


async def main() -> None:
    vfs = build_vfs(
        "wandb", {
            "entities": ["lab", "other"],
            "api_key": os.environ["WANDB_API_KEY"],
            "base_url": os.environ["WANDB_BASE_URL"],
            "page_size": 2
        })
    assert isinstance(vfs, WandbVFS)
    ws = Workspace({"/wandb": vfs}, mode=MountMode.READ)
    results = []
    try:
        for case in json.loads(
                Path(__file__).with_name("cases.json").read_text()):
            result = await ws.shell(case["command"])
            results.append({
                "name": case["name"],
                "stdout": result.stdout.decode(),
                "stderr": (result.stderr or b"").decode(),
                "exit_code": result.exit_code
            })
        values = await asyncio.gather(
            read(vfs.accessor, path("lab/experiments/run-a/summary.json")),
            read(vfs.accessor, path("other/experiments/run-a/summary.json")))
        assert [json.loads(value) for value in values] == [{
            "score": 0.4
        }, {
            "score": 42
        }]
        assert json.loads(await
                          read(vfs.accessor,
                               path("lab/experiments/run-a/config.json"))) == {
                                   "lr": 0.01,
                                   "label": "café"
                               }
        assert (await
                stat(vfs.accessor,
                     path("lab/experiments/run-a/history.jsonl"))).size is None
        assert (await
                stat(vfs.accessor,
                     path("lab/experiments/run-a/files/notes.txt"))).size == 6
        assert await read(
            vfs.accessor,
            path("lab/experiments/run-a/files/nested/model.bin")) == bytes(
                [0, 1, 2, 255])
        assert os.environ["WANDB_API_KEY"] not in str(vfs.get_state())
        for page_size in (1, 5):
            narrow = WandbVFS(
                WandbConfig(entities=['lab'],
                            api_key=os.environ['WANDB_API_KEY'],
                            base_url=os.environ['WANDB_BASE_URL'],
                            page_size=page_size))
            try:
                data = await read(narrow.accessor,
                                  path('lab/experiments/run-a/history.jsonl'))
                assert [
                    json.loads(line)['_step'] for line in data.splitlines()
                ] == [0, 1, 4, 5]
            finally:
                await narrow.close()
        stream = read_stream(vfs.accessor,
                             path("lab/experiments/run-long/history.jsonl"))
        assert await anext(stream)
        await stream.aclose()
        unauth = WandbVFS(
            WandbConfig(entities=["lab"],
                        api_key="invalid",
                        base_url=os.environ["WANDB_BASE_URL"]))
        try:
            await unauth.accessor.client.projects("lab")
        except PermissionError:
            auth_failed = True
        else:
            auth_failed = False
        finally:
            await unauth.close()
        assert auth_failed
        for command in [
                "cat /wandb/lab/experiments/run-a",
                "cat /wandb/lab/experiments/run-a/files/nested",
                "cat /wandb/lab/experiments/run-a/summary.json/child",
                "cat /wandb/lab/experiments/nope/history.jsonl",
                "cat /wandb/lab/experiments/nope/run.json", "cat /wandb/nope",
                "cat /wandb/lab/experiments/run-a/files/nope",
                "echo bad > /wandb/lab/experiments/run-a/summary.json"
        ]:
            assert (await ws.shell(command)).exit_code != 0
    finally:
        await ws.close()
    requests = await request_checks(os.environ["WANDB_BASE_URL"])
    print(
        json.dumps({
            "cases": results,
            "requests": requests
        },
                   ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
