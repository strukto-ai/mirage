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

import asyncio
import base64
import re
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass, field
from io import BytesIO
from urllib.parse import unquote, urlsplit, urlunsplit

from dulwich.object_format import SHA1
from dulwich.objects import Commit, ObjectID, ShaFile, Tag, Tree
from dulwich.pack import write_pack_objects
from dulwich.repo import BaseRepo

from mirage.commands.builtin.errors import HttpConnectError
from mirage.commands.builtin.utils.http import http_request
from mirage.commands.cli.builtin.git.constants import GITLINK
from mirage.commands.cli.builtin.git.discover import discover
from mirage.commands.cli.builtin.git.errors import (
    GitError,
    MissingRepositoryError,
    NoWorkspaceError,
)
from mirage.commands.cli.builtin.git.refs import read_head
from mirage.commands.cli.builtin.git.repo import open_repo
from mirage.commands.cli.types import CLIView
from mirage.types import PathSpec

FLUSH = b"0000"
SERVICE = "git-upload-pack"
# What mirage asks an upload-pack for: no progress chatter, packs carried on
# the side band so an error can interrupt them, offset deltas, and the
# annotated tags that point into what is sent. Never thin-pack: a thin pack
# names bases outside itself, which a stored pack cannot hold.
CAPABILITIES = (
    "side-band-64k ofs-delta include-tag no-progress agent=git/mirage"
)
USER_AGENT = "git/mirage"
PACK_BAND, ERROR_BAND = 1, 3
REMOTE_HELPER = re.compile(r"^([A-Za-z][A-Za-z0-9+.-]*)://")
SCP_LIKE = re.compile(r"^[^/:]+:")
# The places git's enter_repo tries for a local path, in its order.
REPO_SUFFIXES = ("/.git", "", ".git/.git", ".git")
SYMREF_HEAD = "symref=HEAD:"
PEELED = "^{}"


@dataclass(frozen=True, slots=True)
class Advertisement:
    """What a remote publishes before anything is fetched.

    Args:
        refs (dict[str, str]): every ref name and the object id it holds,
            ``HEAD`` included when the remote has one.
        peeled (dict[str, str]): the commit each annotated tag peels to.
        head (str | None): the ref HEAD points at, None when it is
            detached or the remote does not say.
    """

    refs: dict[str, str] = field(default_factory=dict)
    peeled: dict[str, str] = field(default_factory=dict)
    head: str | None = None


def pkt_line(data: bytes) -> bytes:
    """One pkt-line: four hex digits of length, then the payload.

    Args:
        data (bytes): the payload.
    """
    return b"%04x" % (len(data) + 4) + data


def pkt_lines(data: bytes) -> Iterator[bytes | None]:
    """Split a pkt-line stream, yielding None for each flush.

    Args:
        data (bytes): the stream.
    """
    at = 0
    while at < len(data):
        head = data[at : at + 4]
        try:
            size = int(head, 16)
        except ValueError:
            raise GitError(
                "protocol error: bad line length character: "
                f"{head.decode('latin-1')}"
            ) from None
        if size == 0:
            yield None
            at += 4
            continue
        yield data[at + 4 : at + size]
        at += size


def parse_advertisement(lines: Iterator[bytes | None]) -> Advertisement:
    """Read a protocol v0 ref advertisement.

    Args:
        lines (Iterator[bytes | None]): its pkt-lines, flushes as None.
    """
    refs: dict[str, str] = {}
    peeled: dict[str, str] = {}
    head = None
    for line in lines:
        if line is None:
            continue
        text = line.rstrip(b"\n")
        if b"\0" in text:
            text, caps = text.split(b"\0", 1)
            for cap in caps.decode().split():
                if cap.startswith(SYMREF_HEAD):
                    head = cap[len(SYMREF_HEAD) :]
        oid, _, name = text.decode().partition(" ")
        if name == "capabilities^{}":
            continue
        if name.endswith(PEELED):
            peeled[name[: -len(PEELED)]] = oid
        else:
            refs[name] = oid
    return Advertisement(refs, peeled, head)


def display_url(url: str) -> str:
    """A remote's URL as git prints it: no credentials, no ``.git``.

    Args:
        url (str): the URL or path as configured.
    """
    parts = urlsplit(url)
    if parts.scheme and parts.netloc and "@" in parts.netloc:
        url = urlunsplit(parts._replace(netloc=parts.netloc.rsplit("@")[-1]))
    url = url.rstrip("/")
    return url[:-4] if url.endswith(".git") and len(url) > 4 else url


def missing_objects(
    repo: BaseRepo, wants: list[str], has: Callable[[ObjectID], bool]
) -> list[ShaFile]:
    """Every object reachable from ``wants`` that the other side lacks.

    Commits the other side has stop the walk; the trees of those boundary
    commits are what it already holds, so their contents are left out as
    upload-pack's edge does. Gitlinks name another repository and are
    never followed.

    Args:
        repo (BaseRepo): the repository sending objects.
        wants (list[str]): the object ids asked for.
        has (Callable[[bytes], bool]): whether the receiver holds an id.
    """
    sending: list[ShaFile] = []
    boundary: list[bytes] = []
    seen: set[bytes] = set()
    stack = [want.encode() for want in wants]
    trees: list[bytes] = []
    while stack:
        oid = stack.pop()
        if oid in seen:
            continue
        seen.add(oid)
        if has(ObjectID(oid)):
            boundary.append(oid)
            continue
        obj = repo.object_store[ObjectID(oid)]
        sending.append(obj)
        if isinstance(obj, Tag):
            stack.append(obj.object[1])
        elif isinstance(obj, Commit):
            trees.append(obj.tree)
            stack.extend(obj.parents)
    held: set[bytes] = set()
    for oid in boundary:
        obj = repo.object_store[ObjectID(oid)]
        if isinstance(obj, Commit):
            _walk_tree(repo, obj.tree, held, None)
    for tree in trees:
        _walk_tree(repo, tree, held, sending)
    return sending


def _walk_tree(
    repo: BaseRepo,
    tree: bytes,
    held: set[bytes],
    sending: list[ShaFile] | None,
) -> None:
    """Visit a tree once, collecting what is new into ``sending``.

    Args:
        repo (BaseRepo): the repository holding the tree.
        tree (bytes): the tree id.
        held (set[bytes]): ids already visited or already held.
        sending (list[ShaFile] | None): where new objects go, None to
            only mark the tree as held.
    """
    stack = [tree]
    while stack:
        oid = stack.pop()
        if oid in held:
            continue
        held.add(oid)
        obj = repo.object_store[ObjectID(oid)]
        if sending is not None:
            sending.append(obj)
        if isinstance(obj, Tree):
            stack.extend(
                sha for _, mode, sha in obj.iteritems() if mode != GITLINK
            )


class LocalTransport:
    """A repository inside the workspace, read through the dispatcher.

    Args:
        repo (BaseRepo): the source repository, opened.
        head (str | None): the ref its HEAD points at.
    """

    def __init__(self, repo: BaseRepo, head: str | None) -> None:
        self._repo = repo
        self._head = head

    async def advertise(self) -> Advertisement:
        """The source's refs, as upload-pack would advertise them."""
        return await asyncio.to_thread(self._advertised)

    def _advertised(self) -> Advertisement:
        store = self._repo.object_store
        refs: dict[str, str] = {}
        peeled: dict[str, str] = {}
        for name in sorted(self._repo.refs.allkeys()):
            try:
                oid = self._repo.refs[name]
            except KeyError:
                continue
            if name != b"HEAD" and not name.startswith(b"refs/"):
                continue
            refs[name.decode()] = oid.decode()
            obj = store[oid]
            while isinstance(obj, Tag):
                obj = store[obj.object[1]]
            if obj.id != oid:
                peeled[name.decode()] = obj.id.decode()
        return Advertisement(refs, peeled, self._head)

    async def fetch_pack(
        self,
        wants: list[str],
        haves: list[str],
        has: Callable[[ObjectID], bool],
    ) -> bytes:
        """A pack of everything reachable from ``wants`` the receiver lacks.

        Args:
            wants (list[str]): the object ids asked for.
            haves (list[str]): the receiver's ref tips; unused here,
                where ``has`` answers directly.
            has (Callable[[bytes], bool]): whether the receiver holds
                an id.
        """
        return await asyncio.to_thread(self._packed, wants, has)

    def _packed(
        self, wants: list[str], has: Callable[[ObjectID], bool]
    ) -> bytes:
        objects = missing_objects(self._repo, wants, has)
        if not objects:
            return b""
        out = BytesIO()
        write_pack_objects(out, objects, SHA1, deltify=False)
        return out.getvalue()


class HttpTransport:
    """A remote reached over git's smart HTTP protocol, version 0.

    The credentials a URL carried belong to its origin: when the first
    request is redirected to another one they are dropped, as git reads
    credentials again from the URL it was sent to. Configured headers go
    with every request, which is what git does with ``http.extraHeader``.

    Args:
        url (str): the repository URL, credentials stripped.
        headers (dict[str, str]): extra headers for every request.
        credentials (dict[str, str]): the Authorization header the URL's
            userinfo spelled, empty for none.
    """

    def __init__(
        self, url: str, headers: dict[str, str], credentials: dict[str, str]
    ) -> None:
        self._url = url.rstrip("/")
        self._headers = {"User-Agent": USER_AGENT, **headers}
        self._credentials = credentials
        self._configured = "Authorization" in headers

    async def _request(
        self,
        url: str,
        method: str,
        headers: dict[str, str],
        body: bytes | None,
    ) -> bytes:
        try:
            resp = await http_request(
                url,
                method,
                {**self._headers, **self._credentials, **headers},
                body,
                None,
                follow_redirects=True,
            )
        except ImportError as exc:
            raise GitError(
                "https remotes need httpx: pip install 'mirage[http]'"
            ) from exc
        except HttpConnectError as exc:
            raise GitError(f"unable to access '{self._url}/': {exc}") from exc
        if resp.status in (401, 403):
            if self._configured or self._credentials:
                raise GitError(f"Authentication failed for '{self._url}/'")
            host = urlunsplit(urlsplit(self._url)._replace(path="", query=""))
            raise GitError(
                f"could not read Username for '{host}': "
                "terminal prompts disabled"
            )
        if resp.status == 404:
            raise GitError(f"repository '{self._url}/' not found")
        if resp.is_error:
            raise GitError(
                f"unable to access '{self._url}/': The requested "
                f"URL returned error: {resp.status}"
            )
        if method == "GET":
            moved = resp.url.split("/info/refs", 1)[0]
            if _origin(moved) != _origin(self._url):
                self._credentials = {}
            self._url = moved
        return resp.body

    async def advertise(self) -> Advertisement:
        """GET ``info/refs`` for upload-pack and read what it lists."""
        body = await self._request(
            f"{self._url}/info/refs?service={SERVICE}", "GET", {}, None
        )
        lines = pkt_lines(body)
        first = next(lines, None)
        if (
            first is None
            or first.rstrip(b"\n") != f"# service={SERVICE}".encode()
        ):
            raise GitError(
                f"repository '{self._url}/' is not a smart HTTP git server"
            )
        return parse_advertisement(lines)

    async def fetch_pack(
        self,
        wants: list[str],
        haves: list[str],
        has: Callable[[ObjectID], bool],
    ) -> bytes:
        """POST the wants and haves to upload-pack; return the pack.

        Args:
            wants (list[str]): the object ids asked for.
            haves (list[str]): the receiver's ref tips, so the server
                leaves out what they reach.
            has (Callable[[bytes], bool]): unused here, where the server
                works out what to leave out from ``haves``.
        """
        if not wants:
            return b""
        body = [pkt_line(f"want {wants[0]} {CAPABILITIES}\n".encode())]
        body += [pkt_line(f"want {want}\n".encode()) for want in wants[1:]]
        body.append(FLUSH)
        body += [pkt_line(f"have {have}\n".encode()) for have in haves]
        body.append(pkt_line(b"done\n"))
        reply = await self._request(
            f"{self._url}/{SERVICE}",
            "POST",
            {
                "Content-Type": f"application/x-{SERVICE}-request",
                "Accept": f"application/x-{SERVICE}-result",
            },
            b"".join(body),
        )
        pack = bytearray()
        for line in pkt_lines(reply):
            if line is None or line.startswith((b"NAK", b"ACK ")):
                continue
            band, payload = line[0], line[1:]
            if band == PACK_BAND:
                pack += payload
            elif band == ERROR_BAND:
                raise GitError(
                    "remote error: "
                    + payload.decode("utf-8", "replace").strip()
                )
        return bytes(pack)


def _origin(url: str) -> tuple[str, str]:
    """A URL's scheme and host, the part credentials are scoped to.

    Args:
        url (str): an absolute URL.
    """
    parts = urlsplit(url)
    return parts.scheme.lower(), parts.netloc.lower()


def _credentials(url: str) -> tuple[str, dict[str, str]]:
    """Split userinfo out of a URL into a basic Authorization header.

    Args:
        url (str): the URL as configured.
    """
    parts = urlsplit(url)
    if "@" not in parts.netloc:
        return url, {}
    userinfo, host = parts.netloc.rsplit("@", 1)
    token = base64.b64encode(unquote(userinfo).encode()).decode()
    return urlunsplit(parts._replace(netloc=host)), {
        "Authorization": f"Basic {token}"
    }


def extra_headers(values: list[bytes]) -> dict[str, str]:
    """``http.extraHeader`` values as a header table, later ones winning.

    Args:
        values (list[bytes]): the configured values, in config order.
    """
    headers = {}
    for value in values:
        name, _, text = value.decode("utf-8", "replace").partition(":")
        if name.strip() and text.strip():
            headers[name.strip()] = text.strip()
    return headers


async def open_transport(
    url: str,
    start: PathSpec,
    view: CLIView,
    headers: dict[str, str],
    credentials: Mapping[str, str] | None = None,
) -> LocalTransport | HttpTransport:
    """The transport a remote URL or workspace path names.

    ``https://`` and ``http://`` speak smart HTTP; a path, or a
    ``file://`` URL, is a repository inside the workspace reached through
    the dispatcher. Anything else names a remote helper mirage does not
    have, which git words the same way.

    Args:
        url (str): the remote as typed or configured.
        start (PathSpec): the directory a relative path resolves against.
        view (CLIView): the invocation's view.
        headers (dict[str, str]): extra HTTP headers from config.
        credentials (Mapping[str, str] | None): an Authorization for the
            URL's origin when it carries no userinfo, dropped with it on a
            redirect elsewhere.
    """
    scheme = REMOTE_HELPER.match(url)
    if scheme is not None and scheme.group(1) in ("http", "https"):
        bare, auth = _credentials(url)
        return HttpTransport(bare, headers, auth or dict(credentials or {}))
    if scheme is not None and scheme.group(1) != "file":
        raise GitError(f"Unable to find remote helper for '{scheme.group(1)}'")
    if scheme is None and SCP_LIKE.match(url):
        raise GitError("Unable to find remote helper for 'ssh'")
    dispatch, stat_path = view.dispatch, view.stat_path
    mounts = view.ns.mounts if view.ns is not None else None
    if dispatch is None or stat_path is None or mounts is None:
        raise NoWorkspaceError()
    path = urlsplit(url).path if scheme is not None else url
    scope = PathSpec.from_str_path(unquote(path), cwd=start)
    for suffix in REPO_SUFFIXES:
        candidate = PathSpec.from_str_path(
            (scope.dotted or scope.virtual).rstrip("/") + suffix, cwd="/"
        )
        info = await stat_path(candidate)
        if info is None:
            continue
        try:
            location = await discover(
                dispatch,
                stat_path,
                mounts.root_of,
                candidate.parent,
                candidate,
            )
        except GitError:
            continue
        head = await read_head(dispatch, location.gitdir)
        return LocalTransport(await open_repo(dispatch, location), head.ref)
    raise MissingRepositoryError(url)


def is_local(url: str) -> bool:
    """Whether a remote names a path rather than a URL.

    Args:
        url (str): the remote as typed.
    """
    return REMOTE_HELPER.match(url) is None and SCP_LIKE.match(url) is None
