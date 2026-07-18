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

import argparse
import asyncio
import hashlib
import json
from collections import Counter
from datetime import datetime, timezone

import lz4.frame
from aiohttp import web

# Anchored at run time, mirroring moto and the fake Graph: the real Hub
# stamps lastModified at write time, and a fixed past date would make the
# shared find_mtime case (-mtime -1) exclude every just-written object.
BASE_TIME = datetime.now(timezone.utc).replace(microsecond=0)
MODIFIED = BASE_TIME.strftime("%Y-%m-%dT%H:%M:%SZ")

BOOKEND = b"\xff" * 32
SHARD_HEADER_SIZE = 48
RECORD_SIZE = 48
FILE_FLAG_VERIFICATION = 1 << 31
FILE_FLAG_METADATA_EXT = 1 << 30
# Matches xet's target chunk size; the client's deserializer rejects
# chunks far above it, so the synthetic xorbs stay within real bounds.
SERVE_CHUNK_SIZE = 1 << 16


def freeze_clock(base: datetime) -> None:
    # Pin the stamp for suites that print raw mtimes, mirroring
    # integ/s3.py's moto freeze and onedrive_server.freeze_clock.
    global BASE_TIME, MODIFIED
    BASE_TIME = base
    MODIFIED = base.strftime("%Y-%m-%dT%H:%M:%SZ")


def _hash_hex(raw: bytes) -> str:
    # Xet merkle hashes render as four little-endian u64 words, so the 32
    # raw shard bytes and the hex used in URLs/batch bodies differ in order.
    words = (raw[i:i + 8] for i in range(0, 32, 8))
    return "".join(f"{int.from_bytes(w, 'little'):016x}" for w in words)


def _bg4_regroup(data: bytes) -> bytes:
    # Inverse of xet's byte-grouping-4 split: the stored buffer is the
    # concatenation of every 4th byte starting at offsets 0..3.
    n = len(data)
    k, r = divmod(n, 4)
    sizes = [k + 1 if i < r else k for i in range(4)]
    out = bytearray(n)
    off = 0
    for i, size in enumerate(sizes):
        out[i::4] = data[off:off + size]
        off += size
    return bytes(out)


def _decode_xorb(body: bytes) -> list[bytes]:
    # A xorb is a sequence of chunks, each an 8-byte packed header
    # (version u8, compressed len u24, scheme u8, uncompressed len u24)
    # followed by the possibly-compressed chunk payload.
    chunks: list[bytes] = []
    off = 0
    while off < len(body):
        header = int.from_bytes(body[off:off + 8], "little")
        compressed_len = (header >> 8) & 0xFFFFFF
        scheme = (header >> 32) & 0xFF
        uncompressed_len = (header >> 40) & 0xFFFFFF
        data = body[off + 8:off + 8 + compressed_len]
        if scheme == 0:
            chunk = data
        elif scheme == 1:
            chunk = lz4.frame.decompress(data)
        elif scheme == 2:
            chunk = _bg4_regroup(lz4.frame.decompress(data))
        else:
            raise ValueError(f"unknown xorb compression scheme {scheme}")
        if len(chunk) != uncompressed_len:
            raise ValueError("xorb chunk length mismatch")
        chunks.append(chunk)
        off += 8 + compressed_len
    return chunks


def _encode_chunk(chunk: bytes) -> bytes:
    header = len(chunk) << 8 | len(chunk) << 40
    return header.to_bytes(8, "little") + chunk


def _parse_shard_files(
        body: bytes) -> list[tuple[str, list[tuple[str, int, int, int]]]]:
    # MDB shard file-info section only: (file hash, [(xorb hash, unpacked
    # bytes, chunk start, chunk end)]). The CAS-info section that follows
    # the bookend is redundant with the decoded xorb store.
    files: list[tuple[str, list[tuple[str, int, int, int]]]] = []
    off = SHARD_HEADER_SIZE
    while True:
        file_hash = body[off:off + 32]
        if file_hash == BOOKEND:
            break
        flags = int.from_bytes(body[off + 32:off + 36], "little")
        n_entries = int.from_bytes(body[off + 36:off + 40], "little")
        off += RECORD_SIZE
        entries: list[tuple[str, int, int, int]] = []
        for _ in range(n_entries):
            cas_hash = _hash_hex(body[off:off + 32])
            unpacked = int.from_bytes(body[off + 36:off + 40], "little")
            start = int.from_bytes(body[off + 40:off + 44], "little")
            end = int.from_bytes(body[off + 44:off + 48], "little")
            entries.append((cas_hash, unpacked, start, end))
            off += RECORD_SIZE
        if flags & FILE_FLAG_VERIFICATION:
            off += n_entries * RECORD_SIZE
        if flags & FILE_FLAG_METADATA_EXT:
            off += RECORD_SIZE
        files.append((_hash_hex(file_hash), entries))
    return files


def _serve_hash(data: bytes) -> str:
    # Content-addressed stand-in for the file's xet hash: any 64-hex
    # value works as long as the reconstruction endpoint resolves it.
    return hashlib.sha256(data).hexdigest()


class FakeHub:

    def __init__(self) -> None:
        # bucket ("ns/name") -> path -> {"data", "modified", "etag"}
        self.buckets: dict[str, dict[str, dict]] = {}
        # xorb hash hex -> ordered decoded chunks
        self.xorbs: dict[str, list[bytes]] = {}
        # xet file hash hex -> reconstructed bytes
        self.xet_files: dict[str, bytes] = {}
        self.calls: Counter = Counter()
        self._seq = 0

    def bucket(self, repo: str) -> dict[str, dict]:
        return self.buckets.setdefault(repo, {})

    def _write_file(self, repo: str, path: str, data: bytes) -> None:
        self._seq += 1
        self.xet_files[_serve_hash(data)] = data
        self.bucket(repo)[path.strip("/")] = {
            "data": data,
            "modified": MODIFIED,
            "etag": f"hf-etag-{self._seq}",
        }

    def register_shard(self, body: bytes) -> None:
        for file_hash, entries in _parse_shard_files(body):
            parts: list[bytes] = []
            for cas_hash, unpacked, start, end in entries:
                segment = b"".join(self.xorbs[cas_hash][start:end])
                if len(segment) != unpacked:
                    raise ValueError("shard segment length mismatch")
                parts.append(segment)
            self.xet_files[file_hash] = b"".join(parts)


def _tree_entries(files: dict[str, dict], prefix: str,
                  recursive: bool) -> list[dict]:
    # The real Hub returns 200 with [] for missing subpaths, flat file
    # entries when recursive, and file + directory groupings otherwise.
    base = prefix.strip("/")
    base_slash = base + "/" if base else ""
    entries: dict[str, dict] = {}
    for path, rec in files.items():
        if base and not path.startswith(base_slash):
            continue
        rest = path[len(base_slash):]
        if recursive:
            entries[path] = _file_entry(path, rec)
            continue
        head, _, tail = rest.partition("/")
        child = base_slash + head
        if tail:
            entries.setdefault(
                child, {
                    "type": "directory",
                    "path": child,
                    "uploadedAt": rec["modified"],
                })
        else:
            entries[child] = _file_entry(child, rec)
    return sorted(entries.values(), key=lambda e: e["path"])


def _file_entry(path: str, rec: dict) -> dict:
    return {
        "type": "file",
        "path": path,
        "size": len(rec["data"]),
        "xetHash": _serve_hash(rec["data"]),
        "uploadedAt": rec["modified"],
    }


def _parse_http_range(header: str | None, size: int) -> tuple[int, int]:
    # Returns a right-exclusive [start, end) window clamped to size.
    if not header or not header.startswith("bytes="):
        return 0, size
    start_s, _, end_s = header[len("bytes="):].partition("-")
    start = int(start_s) if start_s else 0
    end = int(end_s) + 1 if end_s else size
    return start, min(end, size)


class HubServer:

    def __init__(self, hub: FakeHub) -> None:
        self.hub = hub
        self.port = 0

    @property
    def endpoint(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def _repo(self, request: web.Request) -> str:
        return f"{request.match_info['ns']}/{request.match_info['name']}"

    async def tree(self, request: web.Request) -> web.Response:
        self.hub.calls["tree"] += 1
        files = self.hub.bucket(self._repo(request))
        recursive = request.query.get("recursive", "").lower() in ("true", "1")
        entries = _tree_entries(files, request.match_info["path"], recursive)
        return web.json_response(entries)

    async def resolve(self, request: web.Request) -> web.Response:
        # HEAD is opendal's bucket stat probe (X-Xet-Hash / X-Linked-Size,
        # then a CAS reconstruction download); GET serves the bytes
        # directly, standing in for the real hub's 302 to its CDN bridge.
        self.hub.calls["resolve"] += 1
        files = self.hub.bucket(self._repo(request))
        rec = files.get(request.match_info["path"].strip("/"))
        if rec is None:
            return web.json_response({"error": "Entry not found"}, status=404)
        data = rec["data"]
        headers = {
            "X-Xet-Hash": _serve_hash(data),
            "X-Linked-Size": str(len(data)),
            "X-Linked-ETag": f'"{_serve_hash(data)}"',
            "Accept-Ranges": "bytes",
        }
        if request.method == "HEAD":
            headers["Content-Length"] = str(len(data))
            return web.Response(headers=headers)
        # The real hub 302s to its CDN bridge; clients follow the redirect
        # and fetch the bytes there.
        headers["Location"] = (f"{self.endpoint}/cdn/{self._repo(request)}/"
                               f"{_serve_hash(data)}")
        return web.Response(status=302, headers=headers)

    async def cdn(self, request: web.Request) -> web.Response:
        # Stand-in for the cas-bridge CDN that resolve redirects to.
        self.hub.calls["cdn"] += 1
        data = self.hub.xet_files.get(request.match_info["hash"])
        if data is None:
            return web.Response(status=404)
        rng = request.headers.get("Range")
        start, end = _parse_http_range(rng, len(data))
        headers = {"Accept-Ranges": "bytes"}
        if rng:
            headers["Content-Range"] = f"bytes {start}-{end - 1}/{len(data)}"
            return web.Response(body=data[start:end],
                                status=206,
                                headers=headers)
        return web.Response(body=data, headers=headers)

    async def paths_info(self, request: web.Request) -> web.Response:
        self.hub.calls["paths_info"] += 1
        files = self.hub.bucket(self._repo(request))
        form = await request.post()
        entries: list[dict] = []
        for raw in form.getall("paths", []):
            key = str(raw).strip("/")
            rec = files.get(key)
            if rec is not None:
                entries.append(_file_entry(key, rec))
            elif any(k.startswith(key + "/") for k in files):
                entries.append({
                    "type": "directory",
                    "path": key,
                    "uploadedAt": MODIFIED,
                })
        return web.json_response(entries)

    async def xet_token(self, request: web.Request) -> web.Response:
        self.hub.calls["xet_token"] += 1
        return web.json_response({
            "accessToken": "integ-xet-token",
            "casUrl": f"{self.endpoint}/cas",
            "exp": 9_999_999_999,
        })

    async def batch(self, request: web.Request) -> web.Response:
        self.hub.calls["batch"] += 1
        repo = self._repo(request)
        files = self.hub.bucket(repo)
        body = await request.read()
        for line in body.splitlines():
            if not line.strip():
                continue
            op = json.loads(line)
            kind = op["type"]
            path = op["path"].strip("/")
            if kind == "addFile":
                self.hub._write_file(repo, path,
                                     self.hub.xet_files[op["xetHash"]])
            elif kind == "deleteFile":
                files.pop(path, None)
            elif kind == "deleteFolder":
                for key in [k for k in files if k.startswith(path + "/")]:
                    files.pop(key)
            else:
                return web.json_response(
                    {"error": f"unsupported batch op {kind}"}, status=400)
        return web.json_response({"success": True})

    async def cas_chunks(self, request: web.Request) -> web.Response:
        # Global dedup lookup: always miss so clients upload their xorbs.
        self.hub.calls["cas_chunks"] += 1
        return web.Response(status=404)

    async def cas_xorb(self, request: web.Request) -> web.Response:
        self.hub.calls["cas_xorb"] += 1
        body = await request.read()
        self.hub.xorbs[request.match_info["hash"]] = _decode_xorb(body)
        return web.json_response({"was_inserted": True})

    async def cas_shard(self, request: web.Request) -> web.Response:
        self.hub.calls["cas_shard"] += 1
        self.hub.register_shard(await request.read())
        return web.json_response({"result": 1})

    async def cas_reconstruction_v2(self,
                                    request: web.Request) -> web.Response:
        # Only the V1 protocol is served; clients probe V2 and fall back.
        self.hub.calls["cas_reconstruction_v2"] += 1
        return web.Response(status=404)

    async def cas_reconstruction(self, request: web.Request) -> web.Response:
        self.hub.calls["cas_reconstruction"] += 1
        data = self.hub.xet_files.get(request.match_info["hash"])
        if data is None:
            return web.Response(status=404)
        start, end = _parse_http_range(request.headers.get("Range"), len(data))
        if start >= len(data):
            if request.headers.get("Range"):
                # Over-EOF segment probes get 416; the client maps it to
                # end-of-file (xet-client remote_client handles 416 -> None).
                return web.Response(status=416)
            return web.json_response({
                "offset_into_first_range": 0,
                "terms": [],
                "fetch_info": {},
            })
        chunk_first = start // SERVE_CHUNK_SIZE
        chunk_last = max(chunk_first, (max(end, 1) - 1) // SERVE_CHUNK_SIZE)
        # One term spanning the whole contiguous chunk range, mirroring
        # xet-client's simulation server (one term per xorb segment).
        span = data[chunk_first * SERVE_CHUNK_SIZE:(chunk_last + 1) *
                    SERVE_CHUNK_SIZE]
        serialized_len = sum(
            8 + len(data[i * SERVE_CHUNK_SIZE:(i + 1) * SERVE_CHUNK_SIZE])
            for i in range(chunk_first, chunk_last + 1))
        chunk_range = {"start": chunk_first, "end": chunk_last + 1}
        term = {
            "hash": request.match_info["hash"],
            "unpacked_length": len(span),
            "range": chunk_range,
        }
        fetch = {
            "range": chunk_range,
            "url": f"{self.endpoint}/cas/data/{request.match_info['hash']}",
            "url_range": {
                "start": serialized_offset_of(chunk_first),
                "end": serialized_offset_of(chunk_first) + serialized_len - 1
            },
        }
        return web.json_response({
            "offset_into_first_range":
            start - chunk_first * SERVE_CHUNK_SIZE,
            "terms": [term],
            "fetch_info": {
                request.match_info["hash"]: [fetch]
            },
        })

    async def cas_data(self, request: web.Request) -> web.Response:
        # Serves the synthetic serialized xorb (scheme-0 chunks) that the
        # reconstruction fetch_info URLs point at, honoring Range.
        self.hub.calls["cas_data"] += 1
        data = self.hub.xet_files.get(request.match_info["hash"])
        if data is None:
            return web.Response(status=404)
        serialized = b"".join(
            _encode_chunk(data[off:off + SERVE_CHUNK_SIZE])
            for off in range(0, max(len(data), 1), SERVE_CHUNK_SIZE))
        start, end = _parse_http_range(request.headers.get("Range"),
                                       len(serialized))
        status = 206 if request.headers.get("Range") else 200
        return web.Response(body=serialized[start:end], status=status)


def serialized_offset_of(chunk_index: int) -> int:
    # Every serve-side chunk except the last is exactly SERVE_CHUNK_SIZE
    # bytes plus the 8-byte header.
    return chunk_index * (8 + SERVE_CHUNK_SIZE)


def _build_app(server: HubServer) -> web.Application:
    app = web.Application(client_max_size=256 * 1024 * 1024)
    app.router.add_get("/api/buckets/{ns}/{name}/tree/{path:.*}", server.tree)
    app.router.add_get("/buckets/{ns}/{name}/resolve/{path:.*}",
                       server.resolve)
    app.router.add_post("/api/buckets/{ns}/{name}/paths-info",
                        server.paths_info)
    app.router.add_get("/cdn/{ns}/{name}/{hash}", server.cdn)
    app.router.add_get("/api/buckets/{ns}/{name}/xet-read-token",
                       server.xet_token)
    app.router.add_get("/api/buckets/{ns}/{name}/xet-write-token",
                       server.xet_token)
    app.router.add_post("/api/buckets/{ns}/{name}/batch", server.batch)
    app.router.add_get("/cas/v1/chunks/{prefix}/{hash}", server.cas_chunks)
    app.router.add_post("/cas/v1/xorbs/{prefix}/{hash}", server.cas_xorb)
    app.router.add_post("/cas/shards", server.cas_shard)
    app.router.add_get("/cas/v2/reconstructions/{hash}",
                       server.cas_reconstruction_v2)
    app.router.add_get("/cas/v1/reconstructions/{hash}",
                       server.cas_reconstruction)
    app.router.add_get("/cas/data/{hash}", server.cas_data)
    return app


async def start_fake_hub(
        port: int = 0) -> tuple[FakeHub, HubServer, web.AppRunner]:
    hub = FakeHub()
    server = HubServer(hub)
    runner = web.AppRunner(_build_app(server))
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", port)
    await site.start()
    assert runner.addresses
    server.port = runner.addresses[0][1]
    return hub, server, runner


async def _serve(port: int) -> None:
    _hub, server, _runner = await start_fake_hub(port)
    print(f"HF_ENDPOINT={server.endpoint}", flush=True)
    await asyncio.Event().wait()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    asyncio.run(_serve(args.port))
