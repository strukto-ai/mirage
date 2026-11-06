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


import json
import logging
import os
import uuid
from pathlib import Path

import aiofiles
import yaml

from mirage.concurrency.limiter import run_blocking
from mirage.resources.base import ResourceStore
from mirage.resources.constants import DEFAULT_SCOPE
from mirage.resources.errors import ResourceError
from mirage.resources.store import RecordResourceStore
from mirage.resources.types import EntryKind, Fields
from mirage.server.paths import resources_root_path

logger = logging.getLogger(__name__)

# The folder under the root that holds sealed values, apart from the
# records.
SEALED_DIR = ".sealed"


async def read_or_none(path: Path) -> str | None:
    try:
        async with aiofiles.open(path, encoding="utf-8") as f:
            text: str = await f.read()
    except FileNotFoundError:
        return None
    return text


def unlink_if_present(path: Path) -> bool:
    try:
        path.unlink()
    except FileNotFoundError:
        return False
    return True


def dump(record: Fields) -> str:
    """A record as both hosts write it: JSON, which is also YAML, so each
    reads back the same values whatever its YAML rules.

    Args:
        record (Fields): the record.
    """
    return json.dumps(record, indent=2, ensure_ascii=False) + "\n"


# YAML 1.1 reads an unquoted date as a date, which JSON cannot write back;
# a hand-edited record keeps it as the string it is.
TIMESTAMP = "tag:yaml.org,2002:timestamp"


class PlainLoader(yaml.SafeLoader):
    """Python's safe YAML loader without timestamps, so every value it
    reads is one JSON can write back."""

    yaml_implicit_resolvers = {
        first: [(tag, rule) for tag, rule in resolvers if tag != TIMESTAMP]
        for first, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
    }


def parse_record(path: Path, text: str) -> Fields:
    """A record read back: JSON as written, else YAML, for a file edited
    by hand. Neither the log nor the error, traceback included, quotes the
    file, since a sealed one holds secrets and the parser's message quotes
    the line it stopped at.

    Args:
        path (Path): the file, for the error.
        text (str): its content.

    Raises:
        ResourceError: ``invalid`` when it is not a mapping.
    """
    try:
        record = json.loads(text)
    except ValueError:
        logger.debug("a record is not JSON; reading it as YAML")
        try:
            record = yaml.load(text, Loader=PlainLoader)
            json.dumps(record)
        except (yaml.YAMLError, TypeError, ValueError):
            raise ResourceError("invalid", f"{path} is malformed") from None
    if not isinstance(record, dict):
        raise ResourceError("invalid", f"{path} is not a mapping")
    return record


def write_whole(path: Path, text: str, mode: int, dir_mode: int) -> None:
    """Write ``text`` to ``path`` whole: a temp file created with
    ``mode``, synced, then renamed over it, so a reader never sees a torn
    file and a sealed one is never readable by others, not even while
    written.

    Args:
        path (Path): the file to write.
        text (str): its new content.
        mode (int): the file's permission bits.
        dir_mode (int): the permission bits of folders it creates.
    """
    path.parent.mkdir(parents=True, exist_ok=True, mode=dir_mode)
    tmp = path.with_name(f"{path.name}.{uuid.uuid4()}.tmp")
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        unlink_if_present(tmp)
        raise


class FileRecords:
    """Each record a YAML file at ``<root>/<folder>/<name>.yaml``, owner
    only, since a template's config may hold a credential."""

    def __init__(self, root: Path) -> None:
        self._root = root

    def _path(self, folder: str, name: str) -> Path:
        return self._root / folder / f"{name}.yaml"

    async def read(self, folder: str, name: str) -> Fields | None:
        path = self._path(folder, name)
        text = await read_or_none(path)
        if text is None:
            return None
        return parse_record(path, text)

    async def write(self, folder: str, name: str, record: Fields) -> None:
        await run_blocking(
            write_whole, self._path(folder, name), dump(record), 0o600, 0o700
        )

    async def remove(self, folder: str, name: str) -> bool:
        return await run_blocking(unlink_if_present, self._path(folder, name))

    async def names(self, folder: str) -> list[str]:
        try:
            files = await run_blocking(os.listdir, self._root / folder)
        except FileNotFoundError:
            return []
        return [f.removesuffix(".yaml") for f in files if f.endswith(".yaml")]


class FileSealer:
    """Each entry's sealed values a JSON file at
    ``<root>/<kind>/<name>.json``, mode 0600 in 0700 folders."""

    def __init__(self, root: Path) -> None:
        self._root = root

    def _path(self, kind: EntryKind, name: str) -> Path:
        return self._root / kind / f"{name}.json"

    async def read(self, kind: EntryKind, name: str) -> Fields:
        path = self._path(kind, name)
        text = await read_or_none(path)
        if text is None:
            return {}
        return parse_record(path, text)

    async def write(self, kind: EntryKind, name: str, values: Fields) -> None:
        if not values:
            await self.wipe(kind, name)
            return
        await run_blocking(
            write_whole,
            self._path(kind, name),
            dump(values),
            0o600,
            0o700,
        )

    async def wipe(self, kind: EntryKind, name: str) -> None:
        await run_blocking(unlink_if_present, self._path(kind, name))


def files_resource_store(root: Path | None = None) -> ResourceStore:
    """The local daemon's store: records under ``root``, sealed values
    under ``root/.sealed``.

    Args:
        root (Path | None): the folder; defaults to ``resources`` under
            the mirage home.
    """
    base = root if root is not None else resources_root_path()
    return RecordResourceStore(
        DEFAULT_SCOPE, FileRecords(base), FileSealer(base / SEALED_DIR)
    )
