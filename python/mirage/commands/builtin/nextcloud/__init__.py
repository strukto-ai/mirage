from mirage.commands.builtin.filetype_factory import make_filetype_commands
from mirage.commands.builtin.nextcloud._provision import \
    file_read_provision as _ft_provision
from mirage.commands.builtin.nextcloud.awk import awk
from mirage.commands.builtin.nextcloud.base64_cmd import base64_cmd
from mirage.commands.builtin.nextcloud.basename import basename
from mirage.commands.builtin.nextcloud.cat import cat
from mirage.commands.builtin.nextcloud.cmp import cmp_cmd
from mirage.commands.builtin.nextcloud.column import column
from mirage.commands.builtin.nextcloud.comm import comm
from mirage.commands.builtin.nextcloud.cp import cp
from mirage.commands.builtin.nextcloud.csplit import csplit
from mirage.commands.builtin.nextcloud.cut import cut
from mirage.commands.builtin.nextcloud.diff import diff
from mirage.commands.builtin.nextcloud.dirname import dirname
from mirage.commands.builtin.nextcloud.du import du
from mirage.commands.builtin.nextcloud.expand import expand
from mirage.commands.builtin.nextcloud.file import file
from mirage.commands.builtin.nextcloud.find import find
from mirage.commands.builtin.nextcloud.fmt import fmt
from mirage.commands.builtin.nextcloud.fold import fold
from mirage.commands.builtin.nextcloud.grep import grep
from mirage.commands.builtin.nextcloud.gunzip import gunzip
from mirage.commands.builtin.nextcloud.gzip import gzip
from mirage.commands.builtin.nextcloud.head import head
from mirage.commands.builtin.nextcloud.iconv import iconv
from mirage.commands.builtin.nextcloud.join import join
from mirage.commands.builtin.nextcloud.jq import jq
from mirage.commands.builtin.nextcloud.ln import ln
from mirage.commands.builtin.nextcloud.look import look
from mirage.commands.builtin.nextcloud.ls import ls
from mirage.commands.builtin.nextcloud.md5 import md5
from mirage.commands.builtin.nextcloud.mkdir import mkdir
from mirage.commands.builtin.nextcloud.mktemp import mktemp
from mirage.commands.builtin.nextcloud.mv import mv
from mirage.commands.builtin.nextcloud.nl import nl
from mirage.commands.builtin.nextcloud.paste import paste
from mirage.commands.builtin.nextcloud.patch import patch
from mirage.commands.builtin.nextcloud.readlink import readlink
from mirage.commands.builtin.nextcloud.realpath import realpath
from mirage.commands.builtin.nextcloud.rev import rev
from mirage.commands.builtin.nextcloud.rg import rg
from mirage.commands.builtin.nextcloud.rm import rm
from mirage.commands.builtin.nextcloud.sed import sed
from mirage.commands.builtin.nextcloud.sha256sum import sha256sum
from mirage.commands.builtin.nextcloud.shuf import shuf
from mirage.commands.builtin.nextcloud.sort import sort
from mirage.commands.builtin.nextcloud.split import split
from mirage.commands.builtin.nextcloud.stat import stat
from mirage.commands.builtin.nextcloud.strings import strings
from mirage.commands.builtin.nextcloud.tac import tac
from mirage.commands.builtin.nextcloud.tail import tail
from mirage.commands.builtin.nextcloud.tar import tar
from mirage.commands.builtin.nextcloud.tee import tee
from mirage.commands.builtin.nextcloud.touch import touch
from mirage.commands.builtin.nextcloud.tr import tr
from mirage.commands.builtin.nextcloud.tree import tree
from mirage.commands.builtin.nextcloud.tsort import tsort
from mirage.commands.builtin.nextcloud.unexpand import unexpand
from mirage.commands.builtin.nextcloud.uniq import uniq
from mirage.commands.builtin.nextcloud.unzip import unzip as unzip_cmd
from mirage.commands.builtin.nextcloud.wc import wc
from mirage.commands.builtin.nextcloud.xxd import xxd
from mirage.commands.builtin.nextcloud.zcat import zcat
from mirage.commands.builtin.nextcloud.zgrep import zgrep
from mirage.commands.builtin.nextcloud.zip_cmd import zip_cmd
from mirage.core.nextcloud.glob import resolve_glob as _ft_resolve_glob
from mirage.core.nextcloud.read import read_bytes as _ft_read

COMMANDS = [
    *make_filetype_commands(
        "nextcloud", _ft_resolve_glob, _ft_read, provision=_ft_provision),
    awk,
    base64_cmd,
    basename,
    cat,
    cmp_cmd,
    column,
    comm,
    cp,
    csplit,
    cut,
    diff,
    dirname,
    du,
    expand,
    file,
    find,
    fmt,
    fold,
    grep,
    gunzip,
    gzip,
    head,
    iconv,
    join,
    jq,
    ln,
    look,
    ls,
    md5,
    mkdir,
    mktemp,
    mv,
    nl,
    paste,
    patch,
    readlink,
    realpath,
    rev,
    rg,
    rm,
    sed,
    sha256sum,
    shuf,
    sort,
    split,
    stat,
    strings,
    tac,
    tail,
    tar,
    tee,
    touch,
    tr,
    tree,
    tsort,
    unexpand,
    uniq,
    unzip_cmd,
    wc,
    xxd,
    zcat,
    zgrep,
    zip_cmd,
]
