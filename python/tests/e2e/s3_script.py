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

import hashlib
from dataclasses import dataclass, field
from typing import Any

MD5 = "md5"
OTHER = "other"


@dataclass(frozen=True)
class Step:
    """One request of a script.

    A condition value of the form ``@key`` stands for the ETag ``key``
    holds when the step runs, so a script names a current version without
    knowing the store's ETag; a missing key resolves to a fixed stale tag.

    Args:
        op (str): ``put``, ``get``, ``head``, ``copy``, ``delete``,
            ``delete_objects`` or ``list``.
        key (str): Object key, or the destination of a copy.
        body (bytes): Content of a put.
        src (str): Source key of a copy.
        if_match (str | None): ``IfMatch`` of a put, copy or delete.
        if_none_match (str | None): ``IfNoneMatch`` of a put or copy.
        copy_source_if_match (str | None): ``CopySourceIfMatch`` of a copy.
        keys (tuple[tuple[str, str | None], ...]): ``delete_objects`` rows,
            each a key and an optional ETag condition.
        prefix (str): Prefix of a list.
        delimiter (str): Delimiter of a list.
    """

    op: str
    key: str = ""
    body: bytes = b""
    src: str = ""
    if_match: str | None = None
    if_none_match: str | None = None
    copy_source_if_match: str | None = None
    keys: tuple[tuple[str, str | None], ...] = ()
    prefix: str = ""
    delimiter: str = ""


@dataclass(frozen=True)
class Outcome:
    """What a store answered one step, reduced to what can be compared.

    Args:
        code (str | None): Error code, None on success.
        status (str): HTTP status class, ``2xx`` or ``4xx``; ``unknown``
            when the client reports none.
        detail (tuple[str, ...]): Sorted facts of a success: ETag shape,
            per-key results of a bulk delete, the rows of a listing.
    """

    code: str | None
    status: str
    detail: tuple[str, ...] = ()


@dataclass(frozen=True)
class Trace:
    """The outcome of every step and the store's state after the last.

    Args:
        outcomes (tuple[Outcome, ...]): One per step.
        state (tuple[tuple[str, str], ...]): Key and ETag shape per object.
    """

    outcomes: tuple[Outcome, ...]
    state: tuple[tuple[str, str], ...]


@dataclass
class _Run:
    client: Any
    bucket: str
    etags: dict[str, str] = field(default_factory=dict)


STALE = '"00000000000000000000000000000000"'


def _bare(etag: str) -> str:
    return etag.strip('"')


def _shape(etag: str, body: bytes) -> str:
    return MD5 if _bare(etag) == hashlib.md5(body).hexdigest() else OTHER


def _status_class(status: int | None) -> str:
    return "unknown" if status is None else f"{status // 100}xx"


def _error(exc: Exception) -> Outcome:
    response = getattr(exc, "response", None)
    if response is None:
        raise exc
    code = response.get("Error", {}).get("Code")
    status = response.get("ResponseMetadata", {}).get("HTTPStatusCode")
    return Outcome(str(code), _status_class(status))


async def _resolve(run: _Run, value: str | None) -> str | None:
    if value is None or not value.startswith("@"):
        return value
    try:
        head = await run.client.head_object(Bucket=run.bucket, Key=value[1:])
    except Exception:
        return STALE
    return str(head["ETag"])


async def _conditions(run: _Run, step: Step) -> dict[str, str]:
    sent = {
        "IfMatch": await _resolve(run, step.if_match),
        "IfNoneMatch": await _resolve(run, step.if_none_match),
        "CopySourceIfMatch": await _resolve(run, step.copy_source_if_match),
    }
    return {k: v for k, v in sent.items() if v is not None}


async def _listing(run: _Run, step: Step) -> Outcome:
    resp = await run.client.list_objects_v2(
        Bucket=run.bucket, Prefix=step.prefix, Delimiter=step.delimiter
    )
    rows = [f"key:{o['Key']}" for o in resp.get("Contents") or []]
    rows += [f"prefix:{p['Prefix']}" for p in resp.get("CommonPrefixes") or []]
    return Outcome(None, "2xx", tuple(rows))


async def _bulk(run: _Run, step: Step) -> Outcome:
    objects = []
    for key, etag in step.keys:
        row = {"Key": key}
        resolved = await _resolve(run, etag)
        if resolved is not None:
            row["ETag"] = resolved
        objects.append(row)
    resp = await run.client.delete_objects(
        Bucket=run.bucket, Delete={"Objects": objects}
    )
    rows = [f"deleted:{d['Key']}" for d in resp.get("Deleted") or []]
    rows += [f"error:{e['Key']}:{e['Code']}" for e in resp.get("Errors") or []]
    return Outcome(None, "2xx", tuple(sorted(rows)))


async def _dispatch(run: _Run, step: Step) -> Outcome:
    client, bucket = run.client, run.bucket
    if step.op == "list":
        return await _listing(run, step)
    if step.op == "delete_objects":
        return await _bulk(run, step)
    sent = await _conditions(run, step)
    if step.op == "put":
        resp = await client.put_object(
            Bucket=bucket, Key=step.key, Body=step.body, **sent
        )
        return Outcome(None, "2xx", (_shape(resp["ETag"], step.body),))
    if step.op == "copy":
        resp = await client.copy_object(
            Bucket=bucket,
            Key=step.key,
            CopySource={"Bucket": bucket, "Key": step.src},
            **sent,
        )
        source = await client.get_object(Bucket=bucket, Key=step.src)
        body = await source["Body"].read()
        etag = resp["CopyObjectResult"]["ETag"]
        return Outcome(None, "2xx", (_shape(etag, body),))
    if step.op == "delete":
        await client.delete_object(Bucket=bucket, Key=step.key, **sent)
        return Outcome(None, "2xx")
    if step.op == "head":
        head = await client.head_object(Bucket=bucket, Key=step.key)
        return Outcome(None, "2xx", (f"size:{head['ContentLength']}",))
    got = await client.get_object(Bucket=bucket, Key=step.key)
    return Outcome(None, "2xx", (f"body:{(await got['Body'].read())!r}",))


async def _state(run: _Run) -> tuple[tuple[str, str], ...]:
    resp = await run.client.list_objects_v2(Bucket=run.bucket)
    rows = []
    for obj in resp.get("Contents") or []:
        got = await run.client.get_object(Bucket=run.bucket, Key=obj["Key"])
        body = await got["Body"].read()
        rows.append((obj["Key"], _shape(obj["ETag"], body)))
    return tuple(rows)


async def run_script(
    client: Any, bucket: str, seed: dict[str, bytes], steps: tuple[Step, ...]
) -> Trace:
    """Replay ``steps`` against ``client`` and record what came back.

    Args:
        client (Any): Anything with the aiobotocore S3 client's methods.
        bucket (str): An empty bucket the script owns.
        seed (dict[str, bytes]): Objects put before the first step.
        steps (tuple[Step, ...]): The requests, in order.

    Returns:
        Trace: Each step's outcome and the final key/ETag state.
    """
    run = _Run(client, bucket)
    for key, body in seed.items():
        await client.put_object(Bucket=bucket, Key=key, Body=body)
    outcomes = []
    for step in steps:
        try:
            outcomes.append(await _dispatch(run, step))
        except Exception as exc:
            outcomes.append(_error(exc))
    return Trace(tuple(outcomes), await _state(run))
