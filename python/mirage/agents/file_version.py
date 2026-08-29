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

import base64
import hashlib
from dataclasses import dataclass
from enum import Enum

from mirage.ops.types import LiveFileIdentity
from mirage.workspace.workspace import Workspace


class StaleMirageFileError(Exception):

    def __init__(self, path: str) -> None:
        super().__init__(f"File changed since it was last read: {path}. "
                         f"Read the file again before modifying it.")
        self.path = path


def fingerprint(content: bytes) -> str:
    """Version stamp for one file's stored bytes.

    Args:
        content (bytes): The bytes to stamp.

    Returns:
        str: A base64url digest, matching the TypeScript tracker's stamp.
    """
    digest = hashlib.sha256(content).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


@dataclass(frozen=True, slots=True)
class Stamp:
    """What one file looked like the last time the agent saw it.

    Both fields, never one. ``identity`` is what the backend itself
    said, lifted off the read's own response, so it describes the bytes
    the agent was handed and not a concurrent writer's. ``content_hash``
    is the hash of those same bytes, which costs nothing on a path that
    already holds them and is the only comparator a mount without native
    markers has. An identity-only stamp would have nothing to say on
    such a mount, and one taken from a separate call after the read
    could stamp somebody else's version.

    ``content_hash`` is None in exactly one case: a post-write restamp
    whose backend answered with a marker. Hashing there would mean
    re-reading the file just written, which is the download this design
    exists to remove. The ladder reaches the hash rung from such a stamp
    only if the backend stopped reporting markers between that write and
    the next check; it then refuses the write rather than guessing, so a
    missing baseline costs a spurious refusal in a case that should not
    happen and never an accepted stale write.

    Args:
        identity (LiveFileIdentity | None): the backend's own markers
            for the bytes stamped, None when it reported none.
        content_hash (str | None): hash of the bytes stamped, None only
            for the marker-carrying write restamp described above.
    """

    identity: LiveFileIdentity | None
    content_hash: str | None


class MarkerMatch(Enum):
    """How two identities compared on the strongest marker they share."""

    SAME = "same"
    CHANGED = "changed"
    UNCOMPARABLE = "uncomparable"


def compare_markers(stamp: LiveFileIdentity | None,
                    current: LiveFileIdentity | None) -> MarkerMatch:
    """Compare a stamped identity against the live one, strongest first.

    A revision is a durable handle and a fingerprint only a change
    token, so two revisions settle the question and two fingerprints
    settle it one rung lower. A backend that says the file is gone
    settles it above both, which is the tracker's old "no current
    version" answer. Anything else is UNCOMPARABLE and the caller falls
    back to hashing bytes.

    Args:
        stamp (LiveFileIdentity | None): identity recorded when the
            agent last saw the file.
        current (LiveFileIdentity | None): identity the backend reports
            now, None when the mount has no identity op.

    Returns:
        MarkerMatch: SAME, CHANGED, or UNCOMPARABLE.
    """
    if current is not None and not current.exists:
        return MarkerMatch.CHANGED
    if stamp is None or current is None:
        return MarkerMatch.UNCOMPARABLE
    if stamp.revision is not None and current.revision is not None:
        return (MarkerMatch.SAME
                if stamp.revision == current.revision else MarkerMatch.CHANGED)
    if stamp.fingerprint is not None and current.fingerprint is not None:
        return (MarkerMatch.SAME if stamp.fingerprint == current.fingerprint
                else MarkerMatch.CHANGED)
    return MarkerMatch.UNCOMPARABLE


def has_marker(identity: LiveFileIdentity | None) -> bool:
    """Whether an identity carries a marker the ladder can compare.

    Args:
        identity (LiveFileIdentity | None): the identity to inspect.

    Returns:
        bool: True when the file is there and the backend named a
        revision or a fingerprint for it.
    """
    return (identity is not None and identity.exists
            and (identity.revision is not None
                 or identity.fingerprint is not None))


def hash_differs(stamp: Stamp, current_hash: str | None) -> bool:
    """Whether the hash rung says the file moved.

    A file that is no longer there has moved, and so has one whose
    stamp never took a baseline: neither can show the bytes are the ones
    the agent saw, and this rung answers what it was asked rather than
    guessing in the permissive direction.

    Args:
        stamp (Stamp): what the agent last saw.
        current_hash (str | None): hash of the bytes there now, None
            when the file is gone.

    Returns:
        bool: True when the write must be refused.
    """
    return (stamp.content_hash is None or current_hash is None
            or stamp.content_hash != current_hash)


def moved(stamp: Stamp, current: Stamp) -> bool:
    """Whether two stamps of one path describe different bytes.

    The whole ladder, for the caller that already holds both the live
    identity and the live bytes (a ``read_for_edit``, which has just
    read them) and so owes no ``live_identity`` call of its own.

    Args:
        stamp (Stamp): what the agent last saw.
        current (Stamp): what the file holds now.

    Returns:
        bool: True when the write must be refused.
    """
    verdict = compare_markers(stamp.identity, current.identity)
    if verdict is MarkerMatch.SAME:
        return False
    if verdict is MarkerMatch.CHANGED:
        return True
    return hash_differs(stamp, current.content_hash)


class FileVersionTracker:
    """Refuses a write to a file that moved under the agent.

    Two stamps are kept per path because a read and an edit are
    different promises: `read` records what the agent was shown, and
    `read_for_edit` records what it is about to rewrite. A plain write
    is checked against the read stamp, an edit against the edit stamp.

    A check asks the backend for its own identity first and only hashes
    bytes when that answers nothing, so a mount that knows its versions
    costs one metadata call per check instead of one full download. The
    read-side stamp comes from the read's own response
    (`read_with_identity`), never from a second call: an identity
    fetched after the read would already be a concurrent writer's, and
    the write that should have been refused would sail through.

    Hashes cover the rendered bytes, which is what the read tool hands
    the agent. The TypeScript tracker hashes the stored bytes instead;
    here that would let `edit` search bytes the agent never saw, since
    this side's read tool has always rendered.

    Args:
        workspace (Workspace): The workspace to read and write through.
        enabled (bool): False serves every call unchecked, which is
            what `mirage mcp --no-stale-write-protection` asks for.
    """

    def __init__(self, workspace: Workspace, enabled: bool = True) -> None:
        self._ws = workspace
        self._enabled = enabled
        self._read_versions: dict[str, Stamp] = {}
        self._edit_versions: dict[str, Stamp] = {}

    def _key(self, path: str) -> str:
        """The stamp key for a path: one key per file, not per spelling.

        `ops.read` and `ops.write` follow the namespace symlink table, so
        `/alias` and `/target` are the same file. Keying by the caller's
        spelling would give each its own stamp, and an edit that arrived
        through the other name would find no prior version and skip the
        staleness check entirely.

        Args:
            path (str): Virtual path as the agent spelled it.

        Returns:
            str: The path with symlink prefixes resolved.
        """
        return self._ws.namespace.follow(path)

    async def _current_hash(self, path: str) -> str | None:
        """Hash the bytes the file holds now, the ladder's last rung.

        Args:
            path (str): Virtual path.

        Returns:
            str | None: the hash, None when nothing is there.
        """
        if not await self._ws.ops.exists(path):
            return None
        return fingerprint(await self._ws.ops.read(path))

    async def _assert_version(self, path: str, stamp: Stamp) -> None:
        """Refuse unless the file still holds what the stamp describes.

        One `live_identity` call, then the strongest marker both sides
        carry. The full re-read only happens when neither side has a
        marker to compare, which is every mount whose backend has no
        identity op.

        Args:
            path (str): Virtual path.
            stamp (Stamp): what the agent last saw.

        Raises:
            StaleMirageFileError: The file moved since it was stamped.
        """
        current = await self._ws.ops.live_identity(path)
        verdict = compare_markers(stamp.identity, current)
        if verdict is MarkerMatch.SAME:
            return
        if verdict is MarkerMatch.UNCOMPARABLE and not hash_differs(
                stamp, await self._current_hash(path)):
            return
        raise StaleMirageFileError(path)

    async def _record_write(self, path: str, key: str) -> None:
        """Restamp a path this tracker has just written.

        Stamp what a later read will return, not the bytes handed in. A
        mount whose read op renders answers with something other than
        what was stored, so stamping the input would make the very next
        write or edit look stale with nobody having touched the file.
        A backend that names its own marker says that much in one
        metadata call; only a backend that names none has to be read
        back, and that read is what fills the hash.

        Args:
            path (str): Virtual path.
            key (str): The stamp key the write was checked under.
        """
        if not self._enabled:
            return
        identity = await self._ws.ops.live_identity(path)
        if has_marker(identity):
            self._read_versions[key] = Stamp(identity=identity,
                                             content_hash=None)
        else:
            content_hash = await self._current_hash(path)
            if content_hash is None:
                self._read_versions.pop(key, None)
            else:
                self._read_versions[key] = Stamp(identity=identity,
                                                 content_hash=content_hash)
        self._edit_versions.pop(key, None)

    async def read(self, path: str) -> bytes:
        """Read a file and record what the agent was shown.

        Args:
            path (str): Virtual path.

        Returns:
            bytes: The stored bytes.
        """
        content, identity = await self._ws.ops.read_with_identity(path)
        if self._enabled:
            self._read_versions[self._key(path)] = Stamp(
                identity=identity, content_hash=fingerprint(content))
        return content

    async def read_for_edit(self, path: str) -> bytes:
        """Read a file the agent is about to rewrite.

        Args:
            path (str): Virtual path.

        Returns:
            bytes: The stored bytes.

        Raises:
            StaleMirageFileError: The file moved since it was last read.
        """
        content, identity = await self._ws.ops.read_with_identity(path)
        if not self._enabled:
            return content
        key = self._key(path)
        stamp = Stamp(identity=identity, content_hash=fingerprint(content))
        read_stamp = self._read_versions.get(key)
        if read_stamp is not None and moved(read_stamp, stamp):
            raise StaleMirageFileError(path)
        self._edit_versions[key] = stamp
        return content

    async def write(self, path: str, content: str) -> None:
        """Write a file, refusing if it moved since it was read.

        Args:
            path (str): Virtual path.
            content (str): Text to write.

        Raises:
            StaleMirageFileError: The file moved since it was last read.
        """
        key = self._key(path)
        if self._enabled:
            read_stamp = self._read_versions.get(key)
            if read_stamp is not None:
                await self._assert_version(path, read_stamp)
        await self._ws.ops.write(path, content.encode("utf-8"))
        await self._record_write(path, key)

    async def write_edit(self, path: str, content: str) -> None:
        """Write an edit, refusing if it moved since it was read for edit.

        Args:
            path (str): Virtual path.
            content (str): Text to write.

        Raises:
            StaleMirageFileError: The file moved since it was read for edit.
        """
        key = self._key(path)
        if self._enabled:
            edit_stamp = self._edit_versions.get(key)
            if edit_stamp is not None:
                await self._assert_version(path, edit_stamp)
        await self._ws.ops.write(path, content.encode("utf-8"))
        await self._record_write(path, key)
