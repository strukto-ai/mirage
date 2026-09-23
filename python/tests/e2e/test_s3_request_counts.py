from collections import Counter
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

from mirage.types import MountMode
from mirage.vfs.s3 import S3VFS, S3Config
from mirage.workspace import Workspace
from tests.e2e.s3_mock import MultiBucketSession, patch_s3_session


@pytest.fixture
def counted_s3():
    session = MultiBucketSession(
        {'bucket': {
            'a.txt': b'hello',
            'd/b.txt': b'abc'
        }})
    client = session._client
    counts = Counter()
    original_head = client.head_object
    original_list = client.list_objects_v2
    original_paginator = client.get_paginator

    async def head(**kwargs):
        counts['head'] += 1
        return await original_head(**kwargs)

    async def listing(**kwargs):
        counts['list'] += 1
        return await original_list(**kwargs)

    def paginator(name):
        result = original_paginator(name)
        original = result.paginate

        async def paginate(**kwargs):
            async for page in original(**kwargs):
                counts['list'] += 1
                yield page

        result.paginate = paginate
        return result

    vfs = S3VFS(
        S3Config(bucket='bucket',
                 region='us-east-1',
                 aws_access_key_id='fake',
                 aws_secret_access_key='fake'))
    with (patch_s3_session(session), patch.object(client, 'head_object', head),
          patch.object(client, 'list_objects_v2', listing),
          patch.object(client, 'get_paginator', paginator)):
        yield Workspace({'/s3': (vfs, MountMode.WRITE)}), counts


@pytest.mark.asyncio
@pytest.mark.parametrize('command,expected', [
    ('cat /s3/a.txt', {
        'head': 1
    }),
    ('stat /s3/missing', {
        'head': 1,
        'list': 1
    }),
    ('cp /s3/a.txt /s3/new.txt', {
        'head': 2,
        'list': 1
    }),
    ('mv /s3/a.txt /s3/new.txt', {
        'head': 3,
        'list': 1
    }),
])
async def test_command_request_counts(counted_s3, command, expected):
    ws, counts = counted_s3
    result = await ws.shell(command)
    await result.stdout_str()
    assert result.exit_code == (1 if 'missing' in command else 0)
    assert counts == expected


@pytest.mark.asyncio
async def test_recursive_walks_share_complete_index(counted_s3):
    ws, counts = counted_s3
    cold = await ws.shell('du -a /s3')
    cold_text = await cold.stdout_str()
    counts.clear()
    warm = await ws.shell('du -a /s3')
    assert await warm.stdout_str() == cold_text
    assert counts == {}
    found = await ws.shell('find /s3 -type f')
    assert found.exit_code == 0
    found_text = await found.stdout_str()
    assert 'a.txt' in found_text and 'b.txt' in found_text
    assert counts == {}


@pytest.mark.asyncio
async def test_find_warms_du_on_a_non_root_directory(counted_s3):
    ws, counts = counted_s3
    found = await ws.shell('find /s3/d')
    assert found.exit_code == 0
    assert 'b.txt' in await found.stdout_str()
    counts.clear()
    first = await ws.shell('du -a /s3/d')
    first_text = await first.stdout_str()
    assert first.exit_code == 0
    assert counts == {}
    counts.clear()
    second = await ws.shell('du -a /s3/d')
    assert await second.stdout_str() == first_text
    assert counts == {}


@pytest.mark.asyncio
@pytest.mark.parametrize('warmup', ['find', 'du -a'])
async def test_deleted_recursive_root_is_not_reported_after_expiry(warmup):
    objects = {'d/a.txt': b'old'}
    session = MultiBucketSession({'bucket': objects})
    vfs = S3VFS(
        S3Config(bucket='bucket',
                 region='us-east-1',
                 aws_access_key_id='fake',
                 aws_secret_access_key='fake'))
    ws = Workspace({'/s3': (vfs, MountMode.WRITE)})
    with (patch_s3_session(session), patch('mirage.cache.index.ram.datetime')
          as clock):
        clock.now.return_value = datetime(2026, 1, 1, tzinfo=timezone.utc)
        first = await ws.shell(warmup + ' /s3/d')
        await first.stdout_str()
        assert first.exit_code == 0
        objects.clear()
        clock.now.return_value += timedelta(seconds=601)
        for command in ['stat', 'find']:
            result = await ws.shell(command + ' /s3/d')
            assert await result.stdout_str() == ''
            assert result.exit_code == 1
