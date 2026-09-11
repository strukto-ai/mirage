import asyncio
import os

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.chroma import ChromaConfig, ChromaResource

load_dotenv(".env.development")


def int_env(name: str, default: int) -> int:
    value = os.environ.get(name)
    if value is None:
        return default
    return int(value)


def bool_env(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def build_resource() -> ChromaResource:
    config = ChromaConfig(
        host=os.environ.get("CHROMA_HOST", "localhost"),
        port=int_env("CHROMA_PORT", 8000),
        ssl=bool_env("CHROMA_SSL", False),
        collection_name=require_env("CHROMA_COLLECTION"),
        slug_field=os.environ.get("CHROMA_SLUG_FIELD", "page_slug"),
        chunk_index_field=os.environ.get("CHROMA_CHUNK_INDEX_FIELD",
                                         "chunk_index"),
    )
    return ChromaResource(config=config)


def first_file(directory: str) -> str | None:
    entries = os.listdir(directory)
    for entry in entries:
        path = f"{directory.rstrip('/')}/{entry}"
        if os.path.isdir(path):
            found = first_file(path)
            if found is not None:
                return found
        elif os.path.isfile(path):
            return path
    return None


async def main() -> None:
    resource = build_resource()
    with Workspace({"/knowledge/": resource}, mode=MountMode.READ) as ws:
        print("=== Chroma VFS ===\n")

        print("--- os.listdir('/knowledge') ---")
        for entry in os.listdir("/knowledge")[:20]:
            print(f"  {entry}")

        path = first_file("/knowledge")
        if path is None:
            print("\nNo documents found in the Chroma path tree.")
            return

        print(f"\n--- open('{path}') ---")
        with open(path) as file:
            content = file.read()
        preview = content[:1500]
        print(preview)
        if len(content) > len(preview):
            print("...")

        print("\n--- os.path metadata ---")
        print(f"  exists: {os.path.exists(path)}")
        print(f"  isfile: {os.path.isfile(path)}")
        print(f"  size: {os.path.getsize(path)}")

        records = ws.fs.records
        total = sum(record.bytes for record in records)
        print(f"\nStats: {len(records)} ops, {total} bytes transferred")


if __name__ == "__main__":
    asyncio.run(main())
