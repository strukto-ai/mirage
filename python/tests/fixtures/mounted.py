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

from weakref import WeakKeyDictionary

from mirage.accessor.base import Accessor
from mirage.types import FileStat, MountMode, PathSpec
from mirage.vfs.base import BaseVFS
from mirage.workspace import Workspace
from tests.fixtures.vfs_io import vfs_over

PREFIX = "/m"


class Mounted:
    """A backend's accessor behind a mount, asked by the paths below it:
    the mount lists each folder and hands the backend the rows its
    listings name, so a call answers what a command's would.

    Without a prefix the mount sits at ``/m`` and answers paths below it;
    with one, at that prefix, and answers paths spelled under it.

    Args:
        cls (type[BaseVFS]): the backend's VFS class.
        accessor (Accessor): the accessor the test built.
        prefix (str): where the mount sits, empty for ``/m``.
    """

    def __init__(
        self, cls: type[BaseVFS], accessor: Accessor, prefix: str = ""
    ) -> None:
        self.prefix = prefix
        self.root = prefix or PREFIX
        self.ws = Workspace(
            {self.root + "/": (vfs_over(cls, accessor), MountMode.WRITE)},
            mode=MountMode.WRITE,
        )

    def at(self, path: str | PathSpec) -> PathSpec:
        """The mounted spelling of a path below the mount; a PathSpec is
        read for its key and its glob word.

        Args:
            path (str | PathSpec): the path below the mount.
        """
        if isinstance(path, str):
            key = path.strip("/")
            return PathSpec.from_str_path(
                self.root + ("/" + key if key else "")
            )
        key = path.vfs_path.strip("/")
        if not path.pattern:
            return PathSpec.from_str_path(
                self.root + ("/" + key if key else "")
            )
        folder = key.rsplit("/", 1)[0] if "/" in key else ""
        directory = self.root + ("/" + folder if folder else "")
        return PathSpec(
            virtual=f"{directory}/{path.pattern}",
            directory=directory,
            vfs_path=key,
            pattern=path.pattern,
            resolved=False,
        )

    def _below(self, path: str) -> str:
        return path if self.prefix else path.removeprefix(PREFIX)

    async def readdir(self, path: str | PathSpec) -> list[str]:
        """A folder's children, spelled as the mount's paths are; a glob
        word in it, the children it matches.

        Args:
            path (str | PathSpec): the folder, or a glob word in it.
        """
        spec = self.at(path)
        if spec.pattern:
            echoed = await self.ws.shell(f"echo {spec.virtual}")
            words = (await echoed.stdout_str()).split()
            matched = [] if words == [spec.virtual] else words
            return [self._below(child) for child in matched]
        listed, _ = await self.ws.dispatch("readdir", spec)
        return [self._below(child) for child in listed]

    async def stat(self, path: str | PathSpec) -> FileStat:
        """A path's stat.

        Args:
            path (str | PathSpec): the path.
        """
        row, _ = await self.ws.dispatch("stat", self.at(path))
        return row

    async def read(self, path: str | PathSpec) -> bytes:
        """A file's bytes.

        Args:
            path (str | PathSpec): the file.
        """
        data, _ = await self.ws.dispatch("read", self.at(path))
        return data

    async def unlink(self, path: str | PathSpec) -> None:
        """Remove a file.

        Args:
            path (str | PathSpec): the file.
        """
        await self.ws.dispatch("unlink", self.at(path))


_MOUNTED: WeakKeyDictionary[Accessor, Mounted] = WeakKeyDictionary()


def mounted(
    cls: type[BaseVFS], accessor: Accessor, prefix: str = ""
) -> Mounted:
    """The one mount a test asks ``accessor`` through, so the listings
    one call keeps answer the next, as they do for a command.

    Args:
        cls (type[BaseVFS]): the backend's VFS class.
        accessor (Accessor): the accessor the test built.
        prefix (str): where the mount sits, empty for ``/m``.
    """
    found = _MOUNTED.get(accessor)
    if found is None:
        found = _MOUNTED[accessor] = Mounted(cls, accessor, prefix)
    return found
