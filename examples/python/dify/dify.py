import asyncio
import os
import shlex

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.dify import DifyConfig, DifyResource
from mirage.types import PathSpec

load_dotenv(".env.development")


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def build_resource() -> DifyResource:
    config = DifyConfig(
        api_key=require_env("DIFY_API_KEY"),
        base_url=os.environ.get("DIFY_BASE_URL", "https://api.dify.ai/v1"),
        dataset_id=require_env("DIFY_DATASET_ID"),
        slug_metadata_name=os.environ.get("DIFY_SLUG_METADATA_NAME", "slug"),
    )
    return DifyResource(config=config)


async def run(ws: Workspace, command: str, max_chars: int = 800) -> str:
    result = await ws.execute(command)
    stdout = await result.stdout_str()
    stderr = (result.stderr or b"").decode(errors="replace")
    print(f"$ {command}")
    if stdout:
        output = stdout.strip()
        if len(output) > max_chars:
            output = output[:max_chars] + "\n..."
        print(output)
    if stderr:
        print(stderr.strip())
    print(f"[exit={result.exit_code}]\n")
    return stdout


async def first_document_path(ws: Workspace) -> str | None:
    output = await run(ws, "find /knowledge/ -type f | head -n 1")
    path = output.strip()
    return path or None


async def main() -> None:
    resource = build_resource()
    ws = Workspace({"/knowledge/": resource}, mode=MountMode.READ)

    print("=== Dify Knowledge ===\n")

    await run(ws, "ls /knowledge/")
    await run(ws, "find /knowledge/ -type f | head -n 10")

    first_path = await first_document_path(ws)
    if first_path is None:
        print("No completed documents found in the Dify dataset.")
        return

    quoted_path = shlex.quote(first_path)
    print(f"First document: {first_path}\n")

    await run(ws, f"cat {quoted_path}", max_chars=1200)
    await run(ws, f"head -n 5 {quoted_path}")
    await run(ws, f"tail -n 5 {quoted_path}")
    await run(ws, f"wc {quoted_path}")

    # chmod/chown/touch never hit the Dify API: attrs land in the
    # workspace namespace (durable, snapshot-captured) and merge into
    # dispatch-level stat.
    print(f"=== metadata overlay on {first_path} ===")
    meta_res = await ws.execute(f"chmod 640 {quoted_path}"
                                f" && chown 500:dev {quoted_path}"
                                f" && touch -t 202601021530 {quoted_path}")
    print(f"  chmod/chown/touch exit={meta_res.exit_code}")
    meta_st, _ = await ws.dispatch("stat", PathSpec.from_str_path(first_path))
    print(f"  dispatch stat: mode={oct(meta_st.mode)[2:]} uid={meta_st.uid} "
          f"gid={meta_st.gid} mtime={meta_st.modified}")

    query = os.environ.get("DIFY_EXAMPLE_QUERY", "getting started")
    quoted_query = shlex.quote(query)
    await run(ws, f"grep -i {quoted_query} {quoted_path}")
    await run(ws,
              f"search --method hybrid --top-k 5 {quoted_query} /knowledge/",
              max_chars=1200)

    records = ws.ops.records
    network_bytes = ws.ops.network_bytes
    cache_bytes = ws.ops.cache_bytes
    print("=== Stats ===")
    print(f"{len(records)} ops, {network_bytes} network bytes, "
          f"{cache_bytes} cache bytes")


if __name__ == "__main__":
    asyncio.run(main())
