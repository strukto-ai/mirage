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

from collections.abc import Awaitable, Callable

from mirage.core.object_store.driver import A, C, ObjectStoreDriver
from mirage.ops.types import LiveFileIdentity
from mirage.types import PathSpec
from mirage.utils import key_prefix as kp
from mirage.utils.errors import eisdir
from mirage.utils.key_prefix import mount_prefix_of


def make_identity(
        driver: ObjectStoreDriver[A, C]) -> Callable[[A, PathSpec], Awaitable[LiveFileIdentity]]:
    """Build the no-cache identity lookup over one driver.

    This is stat's slow path only: no index fast path, no directory-hint
    skip, because the guarantee is bypassing every cache, not serving the
    common case fastest. A head miss earns exactly one more call, the
    prefix probe, to tell "absent" from "directory".

    Args:
        driver (ObjectStoreDriver): the store's native surface.
    """

    async def identity(accessor: A, path_spec: PathSpec) -> LiveFileIdentity:
        virtual = path_spec.virtual
        original_prefix = mount_prefix_of(path_spec.virtual,
                                          path_spec.resource_path)
        path = path_spec.virtual
        if original_prefix and path.startswith(original_prefix):
            path = path[len(original_prefix):] or "/"

        stripped = path.strip("/")
        if not stripped:
            raise eisdir(virtual)

        kpfx = driver.key_prefix_of(accessor)
        key = kp.apply(kpfx, path)
        async with driver.connect(accessor) as conn:
            meta = await driver.head(conn, key)
            if meta is not None:
                return LiveFileIdentity(exists=True,
                                        revision=meta.revision,
                                        fingerprint=meta.fingerprint)

            # Head missed: the one allowed second call tells "absent" from
            # "directory" (a marker or any deeper key proves the prefix).
            pfx = key.rstrip("/") + "/" if key else ""
            if await driver.probe_prefix(conn, pfx):
                raise eisdir(virtual)

        return LiveFileIdentity(exists=False, revision=None, fingerprint=None)

    return identity
