from mirage.ops.nextcloud.create import create
from mirage.ops.nextcloud.mkdir import mkdir
from mirage.ops.nextcloud.read import read
from mirage.ops.nextcloud.readdir import readdir
from mirage.ops.nextcloud.rename import rename
from mirage.ops.nextcloud.rmdir import rmdir
from mirage.ops.nextcloud.stat import stat
from mirage.ops.nextcloud.truncate import truncate
from mirage.ops.nextcloud.unlink import unlink
from mirage.ops.nextcloud.write import write as write_bytes

OPS = [
    create, mkdir, read, readdir, rename, rmdir, stat, truncate, unlink,
    write_bytes
]
