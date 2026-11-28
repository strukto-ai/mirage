#[cfg(any(target_os = "linux", target_os = "macos"))]
mod fs;
#[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
mod link;
#[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
mod proto;

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [flag] if flag == "--version" => {
            println!("{}", version());
            ExitCode::SUCCESS
        }
        [command, source, mountpoint] if command == "serve" => serve(source, mountpoint),
        _ => {
            eprintln!("usage: mirage-fuse serve <source> <mountpoint> | mirage-fuse --version");
            ExitCode::from(2)
        }
    }
}

/// Mount `source`'s prefix at `mountpoint` and answer the kernel from what
/// the host serves on stdin and stdout, until the host closes the pipe.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn serve(source: &str, mountpoint: &str) -> ExitCode {
    use fs::{MirageFs, Note, Served, Shared};
    use fuser::INodeNo;
    use serde_json::{Map, json};
    use std::ffi::OsStr;
    use std::io;
    use std::sync::Arc;
    use std::sync::mpsc::channel;

    let Some((_, root)) = source.split_once(':') else {
        eprintln!("mirage-fuse: {source} names no prefix");
        return ExitCode::from(2);
    };
    let link = Arc::new(link::Link::new(Box::new(io::stdout())));
    let (notes, pending) = channel::<Note>();
    let shared = Arc::new(Shared::new(root.to_string(), notes));
    let reader = {
        let (link, shared) = (link.clone(), shared.clone());
        std::thread::spawn(move || {
            if let Err(err) = link.serve(&mut io::stdin().lock(), |frame| shared.push(frame)) {
                eprintln!("mirage-fuse: reading the host failed: {err}");
            }
        })
    };
    let served = match link.call("hello", json!({ "proto": proto::PROTOCOL }), &[]) {
        Ok(frame) if frame.u64("proto") == Some(proto::PROTOCOL) => Served::of(&frame),
        Ok(frame) => {
            eprintln!(
                "mirage-fuse: the host speaks fsproto {:?}, this client {}",
                frame.u64("proto"),
                proto::PROTOCOL
            );
            return ExitCode::from(1);
        }
        Err(err) => {
            eprintln!("mirage-fuse: the host did not answer: {err:?}");
            return ExitCode::from(1);
        }
    };
    let fs = MirageFs::new(link.clone(), shared, served);
    let (mounted, direct) = mount(fs, source, mountpoint);
    let failed = |doing: &str, err: io::Error| {
        eprintln!("mirage-fuse: {doing} {mountpoint} failed: {err}");
        if direct {
            unmount(mountpoint);
        }
        ExitCode::from(1)
    };
    let session = match mounted {
        Ok(session) => session,
        Err(err) => return failed("mounting", err),
    };
    let background = match session.spawn() {
        Ok(background) => background,
        Err(err) => return failed("serving", err),
    };
    let notifier = background.notifier();
    std::thread::spawn(move || {
        let mut kept = false;
        for note in pending {
            let done = match note {
                Note::Entry(parent, name) => {
                    notifier.inval_entry(INodeNo(parent), OsStr::new(&name))
                }
                Note::Inode(ino) => notifier.inval_inode(INodeNo(ino), 0, 0),
                Note::Ack(hid) => {
                    if std::mem::take(&mut kept) {
                        eprintln!(
                            "mirage-fuse: not answering barrier {hid}: the kernel kept what it was told to drop"
                        );
                        continue;
                    }
                    let mut head = Map::new();
                    head.insert("hid".into(), hid.into());
                    if let Err(err) = link.send(&head, &[]) {
                        eprintln!("mirage-fuse: answering a barrier failed: {err}");
                    }
                    continue;
                }
            };
            if let Err(err) = done
                && err.kind() != io::ErrorKind::NotFound
            {
                eprintln!("mirage-fuse: the kernel did not drop an entry: {err}");
                kept = true;
            }
        }
    });
    let _ = reader.join();
    unmount(mountpoint);
    std::process::exit(0)
}

/// The session for `mountpoint`, and whether this process mounted it
/// itself, so it unmounts it when serving fails: mount(2) when it may, else
/// fusermount3 through fuser.
#[cfg(target_os = "linux")]
fn mount(
    fs: fs::MirageFs,
    source: &str,
    mountpoint: &str,
) -> (std::io::Result<fuser::Session<fs::MirageFs>>, bool) {
    use fuser::{Config, MountOption, Session};

    let mut config = Config::default();
    config.n_threads = Some(8);
    config.mount_options = vec![
        MountOption::FSName(source.to_string()),
        MountOption::Subtype("mirage".into()),
        MountOption::NoDev,
        MountOption::NoSuid,
    ];
    match mount_direct(source, mountpoint) {
        Ok(Some(fd)) => (Session::from_fd(fs, fd, config.acl, config), true),
        Ok(None) => (Session::new(fs, mountpoint, &config), false),
        Err(err) => (Err(err), false),
    }
}

/// The session for `mountpoint`, mounted through macFUSE, read from one
/// thread: fuser serves the device from several on Linux alone.
#[cfg(target_os = "macos")]
fn mount(
    fs: fs::MirageFs,
    source: &str,
    mountpoint: &str,
) -> (std::io::Result<fuser::Session<fs::MirageFs>>, bool) {
    let mut config = fuser::Config::default();
    config.n_threads = Some(1);
    match mount_macfuse(source, mountpoint) {
        Ok(fd) => (fuser::Session::from_fd(fs, fd, config.acl, config), true),
        Err(err) => (Err(err), false),
    }
}

/// macFUSE's options for a mount: `fsname` names it as the host looks for
/// it, it reads nothing ahead of a program, keeps Finder's `._` files and
/// `com.apple` attributes out of the workspace, stays off the desktop,
/// raises no dialog, and waits for the host as long as a call may take.
#[cfg(target_os = "macos")]
const MACFUSE_OPTIONS: &str =
    "nosuid,noreadahead,noappledouble,noapplexattr,nobrowse,noalerts,daemon_timeout=600";

/// Where macFUSE installs its libfuse.
#[cfg(target_os = "macos")]
const MACFUSE_LIBRARY: &std::ffi::CStr = c"/usr/local/lib/libfuse.2.dylib";

/// Mount `mountpoint` through macFUSE's libfuse, which this process loads
/// only now, so the binary runs and names its version on a Mac without
/// macFUSE, and links nothing of it. libfuse's channel stays open until the
/// process ends: macFUSE finishes the mount once the session answers the
/// kernel's first request. An error leaves nothing mounted.
#[cfg(target_os = "macos")]
fn mount_macfuse(source: &str, mountpoint: &str) -> std::io::Result<std::os::fd::OwnedFd> {
    use std::ffi::{CStr, CString, c_char, c_int, c_void};
    use std::io::{Error, ErrorKind};
    use std::os::fd::{FromRawFd, OwnedFd};

    #[repr(C)]
    struct Args {
        argc: c_int,
        argv: *mut *mut c_char,
        allocated: c_int,
    }
    type Mount = unsafe extern "C" fn(*const c_char, *mut Args) -> *mut c_void;
    type ChannelFd = unsafe extern "C" fn(*mut c_void) -> c_int;
    type FreeArgs = unsafe extern "C" fn(*mut Args);

    let library = unsafe { libc::dlopen(MACFUSE_LIBRARY.as_ptr(), libc::RTLD_NOW) };
    if library.is_null() {
        return Err(Error::new(ErrorKind::NotFound, "macFUSE is not installed"));
    }
    let symbol = |name: &CStr| {
        let found = unsafe { libc::dlsym(library, name.as_ptr()) };
        if found.is_null() {
            Err(Error::new(
                ErrorKind::Unsupported,
                format!("macFUSE's libfuse has no {}", name.to_string_lossy()),
            ))
        } else {
            Ok(found)
        }
    };
    let mount: Mount = unsafe { std::mem::transmute::<*mut c_void, Mount>(symbol(c"fuse_mount")?) };
    let channel_fd: ChannelFd =
        unsafe { std::mem::transmute::<*mut c_void, ChannelFd>(symbol(c"fuse_chan_fd")?) };
    let free_args: FreeArgs =
        unsafe { std::mem::transmute::<*mut c_void, FreeArgs>(symbol(c"fuse_opt_free_args")?) };
    let bad = |_| Error::from(ErrorKind::InvalidInput);
    let options = format!("fsname={},{MACFUSE_OPTIONS}", source.replace(',', "\\,"));
    let argv = [
        CString::new("mirage-fuse").map_err(bad)?,
        CString::new("-o").map_err(bad)?,
        CString::new(options).map_err(bad)?,
    ];
    let mut pointers: Vec<*mut c_char> = argv.iter().map(|arg| arg.as_ptr().cast_mut()).collect();
    let mut args = Args {
        argc: pointers.len() as c_int,
        argv: pointers.as_mut_ptr(),
        allocated: 0,
    };
    let target = CString::new(mountpoint).map_err(bad)?;
    let channel = unsafe { mount(target.as_ptr(), &mut args) };
    unsafe { free_args(&mut args) };
    if channel.is_null() {
        return Err(Error::other("macFUSE refused the mount"));
    }
    let fd = unsafe { channel_fd(channel) };
    if fd < 0 {
        unmount(mountpoint);
        return Err(Error::other("macFUSE gave the mount no device"));
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

/// Mount `/dev/fuse` at `mountpoint` as `fuse.mirage` when this process
/// may call mount(2) itself, as root does: fuser's own direct mount names
/// the type plain `fuse`, and the host finds its mount by the type. None
/// when mount(2) is refused, for fuser to mount through fusermount3, which
/// names the subtype.
#[cfg(target_os = "linux")]
fn mount_direct(source: &str, mountpoint: &str) -> std::io::Result<Option<std::os::fd::OwnedFd>> {
    use std::ffi::CString;
    use std::io::{Error, ErrorKind};
    use std::os::fd::{AsRawFd, OwnedFd};
    use std::os::unix::fs::MetadataExt;

    let bad = |_| Error::from(ErrorKind::InvalidInput);
    let device = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/fuse")?;
    let rootmode = std::fs::metadata(mountpoint)?.mode() & libc::S_IFMT;
    let data = format!(
        "fd={},rootmode={:o},user_id={},group_id={}",
        device.as_raw_fd(),
        rootmode,
        unsafe { libc::getuid() },
        unsafe { libc::getgid() }
    );
    let (source, target) = (
        CString::new(source).map_err(bad)?,
        CString::new(mountpoint).map_err(bad)?,
    );
    let (kind, data) = (
        CString::new("fuse.mirage").map_err(bad)?,
        CString::new(data).map_err(bad)?,
    );
    let done = unsafe {
        libc::mount(
            source.as_ptr(),
            target.as_ptr(),
            kind.as_ptr(),
            libc::MS_NOSUID | libc::MS_NODEV,
            data.as_ptr().cast(),
        )
    };
    if done == 0 {
        return Ok(Some(OwnedFd::from(device)));
    }
    let error = Error::last_os_error();
    if error.raw_os_error() == Some(libc::EPERM) {
        return Ok(None);
    }
    Err(error)
}

/// Detach the mount, through fusermount when this process may not
/// unmount itself; a mountpoint no longer mounted is left alone.
#[cfg(target_os = "linux")]
fn unmount(mountpoint: &str) {
    let Ok(target) = std::ffi::CString::new(mountpoint) else {
        return;
    };
    if unsafe { libc::umount2(target.as_ptr(), libc::MNT_DETACH) } == 0
        || std::io::Error::last_os_error().raw_os_error() != Some(libc::EPERM)
    {
        return;
    }
    for helper in ["fusermount3", "fusermount"] {
        let done = std::process::Command::new(helper)
            .args(["-uz", mountpoint])
            .status();
        if done.is_ok_and(|status| status.success()) {
            break;
        }
    }
}

/// Detach the mount; one no longer mounted is left alone, and one a
/// program holds open is forced off.
#[cfg(target_os = "macos")]
fn unmount(mountpoint: &str) {
    let Ok(target) = std::ffi::CString::new(mountpoint) else {
        return;
    };
    if unsafe { libc::unmount(target.as_ptr(), 0) } != 0
        && std::io::Error::last_os_error().raw_os_error() == Some(libc::EBUSY)
    {
        unsafe { libc::unmount(target.as_ptr(), libc::MNT_FORCE) };
    }
}

/// The protocol is named only where the binary can serve it, so a host's
/// install check on a machine it cannot mount on refuses it.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn version() -> String {
    format!(
        "mirage-fuse {} fsproto {}",
        env!("CARGO_PKG_VERSION"),
        proto::PROTOCOL
    )
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn version() -> String {
    format!(
        "mirage-fuse {} (serving needs Linux or macOS)",
        env!("CARGO_PKG_VERSION")
    )
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn serve(_source: &str, _mountpoint: &str) -> ExitCode {
    eprintln!("mirage-fuse: serving needs Linux or macOS");
    ExitCode::from(1)
}
