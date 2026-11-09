//! One shell's state beside its variables: the positional parameters of
//! the shell and of each function running, the special parameters, and the
//! `set` and `shopt` options.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::Arc;

use crate::vars::{Indexed, Store};

/// The IFS a shell splits on when IFS is unset: space, tab, newline.
pub const IFS_DEFAULT: &[u8] = b" \t\n";

#[derive(Clone, Debug)]
pub struct Shell {
    pub vars: Store,
    /// The shell's own positional parameters.
    pub positional: Arc<Vec<Vec<u8>>>,
    /// Each running function's positional parameters, innermost last;
    /// a function sees its own, even none (`f` run bare has `$#` of 0).
    pub calls: Arc<Vec<Vec<Vec<u8>>>>,
    /// `$?`.
    pub status: i32,
    /// `$$`.
    pub pid: u32,
    /// `$!`, None before the first background job.
    pub last_job: Option<u32>,
    /// `$0`.
    pub argv0: Vec<u8>,
    /// The `set -o` options on; an absent name is off.
    pub options: HashMap<String, bool>,
    /// The `shopt` options set away from their default.
    pub shopts: HashMap<String, bool>,
    /// `max_env`, None for no cap.
    pub env_limit: Option<usize>,
    /// The bytes left under the workspace's `max_memory` as the operation
    /// starts, which what an expansion builds must fit in; None for no cap.
    pub memory_room: Option<usize>,
    /// The bytes the session holds outside its variables, which
    /// `max_env` counts too: functions, aliases, positional parameters.
    pub outside: usize,
    /// The shell is a `( )` subshell, a compound command forked as a stage
    /// or job, or a fork of one, which a refused `${var:=word}` ends with 2.
    pub paren: bool,
    /// An ERR action is set, which a failing statement runs on the host.
    pub err_trap: bool,
    /// A loop is trying a statement that may yet go to the host, so an
    /// arithmetic expansion that would write or fail stops instead.
    pub attempting: bool,
}

/// What a host hands the shell before an operation: the parameters, the
/// options, the bounds and what the shell keeps of its own, all as the
/// session holds them now.
pub struct Frame {
    pub positional: Option<Vec<Vec<u8>>>,
    pub calls: Option<Vec<Vec<Vec<u8>>>>,
    pub status: i32,
    pub pid: u32,
    pub last_job: Option<u32>,
    pub argv0: Vec<u8>,
    pub options: HashMap<String, bool>,
    pub shopts: HashMap<String, bool>,
    pub env_limit: Option<usize>,
    pub outside: usize,
    pub pipe_status: Vec<i32>,
    pub function_names: Option<Vec<Vec<u8>>>,
    pub call_lines: Vec<usize>,
    pub paren: bool,
    pub memory_room: Option<usize>,
    pub line: usize,
    pub bash_pid: u32,
    pub voice: Vec<u8>,
    pub err_trap: bool,
}

impl Shell {
    /// Take on what the host hands the shell (`Frame`). A host sends the
    /// positional parameters only when they change, so `None` keeps the
    /// ones held, which the shell's clones share rather than copy.
    pub fn apply(&mut self, frame: Frame) {
        if let Some(positional) = frame.positional {
            self.positional = Arc::new(positional);
        }
        if let Some(calls) = frame.calls {
            self.calls = Arc::new(calls);
        }
        self.status = frame.status;
        self.pid = frame.pid;
        self.last_job = frame.last_job;
        self.argv0 = frame.argv0;
        self.options = frame.options;
        self.shopts = frame.shopts;
        self.env_limit = frame.env_limit;
        self.outside = frame.outside;
        self.vars.set_specials(
            frame.pipe_status,
            frame.function_names,
            frame.call_lines,
            frame.line,
            frame.bash_pid,
            frame.voice,
        );
        self.paren = frame.paren;
        self.memory_room = frame.memory_room;
        self.err_trap = frame.err_trap;
    }

    /// What a finished statement leaves: `$?`, and a `PIPESTATUS` of one.
    pub fn record_status(&mut self, status: i32) {
        self.status = status;
        self.vars.stamp_pipe_status(status);
    }

    pub fn new(vars: Store) -> Self {
        Self {
            vars,
            positional: Arc::default(),
            calls: Arc::default(),
            status: 0,
            pid: 0,
            last_job: None,
            argv0: b"mirage".to_vec(),
            options: HashMap::new(),
            shopts: HashMap::new(),
            env_limit: None,
            memory_room: None,
            outside: 0,
            paren: false,
            err_trap: false,
            attempting: false,
        }
    }

    /// A child shell of this one (a subshell, a command substitution): the
    /// same state, `$RANDOM` starting a sequence of its own.
    pub fn subshell(&self) -> Self {
        let mut child = self.clone();
        child.vars = self.vars.subshell();
        child
    }

    /// A `set -o` option: what the session set, else bash's default,
    /// pinned from `bash -c 'set -o'` (5.2.37): only `braceexpand`,
    /// `hashall` and `interactive-comments` start on.
    pub fn option(&self, name: &str) -> bool {
        self.options.get(name).copied().unwrap_or(matches!(
            name,
            "braceexpand" | "hashall" | "interactive-comments"
        ))
    }

    /// A `shopt` option: what the session set, else bash's default.
    pub fn shopt(&self, name: &str) -> bool {
        self.shopts.get(name).copied().unwrap_or(matches!(
            name,
            "checkwinsize"
                | "cmdhist"
                | "complete_fullquote"
                | "extquote"
                | "force_fignore"
                | "globasciiranges"
                | "globskipdots"
                | "hostcomplete"
                | "interactive_comments"
                | "patsub_replacement"
                | "progcomp"
                | "promptvars"
                | "sourcepath"
        ))
    }

    /// `$-`: the letters of the `set` options on, lowercase then
    /// uppercase each in alphabetical order as bash prints them, then `c`
    /// for a shell reading its command from a string (`ehuBc`).
    pub fn flags(&self) -> Vec<u8> {
        const LETTERS: [(u8, &str); 19] = [
            (b'a', "allexport"),
            (b'b', "notify"),
            (b'e', "errexit"),
            (b'f', "noglob"),
            (b'h', "hashall"),
            (b'k', "keyword"),
            (b'm', "monitor"),
            (b'n', "noexec"),
            (b'p', "privileged"),
            (b't', "onecmd"),
            (b'u', "nounset"),
            (b'v', "verbose"),
            (b'x', "xtrace"),
            (b'B', "braceexpand"),
            (b'C', "noclobber"),
            (b'E', "errtrace"),
            (b'H', "histexpand"),
            (b'P', "physical"),
            (b'T', "functrace"),
        ];
        let mut out: Vec<u8> = LETTERS
            .iter()
            .filter(|(_, name)| self.option(name))
            .map(|(letter, _)| *letter)
            .collect();
        out.push(b'c');
        out
    }

    /// The positional parameters in scope: the running function's, else
    /// the shell's.
    pub fn params(&self) -> &[Vec<u8>] {
        self.calls.last().unwrap_or(&*self.positional)
    }

    /// An indexed array by name: `PIPESTATUS` and `FUNCNAME` from the
    /// shell's own bookkeeping, which a lookup answers and an assignment
    /// never reaches, else the variable's.
    pub fn indexed(&self, name: &str) -> Option<Cow<'_, Indexed>> {
        if self.vars.hidden(name) {
            return None;
        }
        self.vars.array(name)
    }

    /// What `$name` reads: element 0 of an array, a map's key `0`, the
    /// live `LINENO` or `BASHPID`, else the scalar; None when it holds
    /// none. Drawing `$RANDOM` is the caller's.
    pub fn zero(&self, name: &str) -> Option<Vec<u8>> {
        if let Some(array) = self.indexed(name) {
            return array.get(0).map(<[u8]>::to_vec);
        }
        if let Some(map) = self.vars.assoc(name) {
            return map.get(b"0").map(<[u8]>::to_vec);
        }
        self.vars
            .dynamic(name)
            .or_else(|| self.vars.scalar(name).map(<[u8]>::to_vec))
    }

    /// The IFS in scope, None when it is unset, which splits as the
    /// default does.
    pub fn ifs(&self) -> Option<&[u8]> {
        self.vars.scalar("IFS")
    }

    /// The home directory `~` names: `$HOME`, or `/` when unset, which
    /// bash answers for a user with no entry in its user database.
    pub fn home(&self) -> &[u8] {
        self.vars.scalar("HOME").unwrap_or(b"/")
    }

    /// Whether characters are UTF-8 here (`Store::utf8`).
    pub fn utf8(&self) -> bool {
        self.vars.utf8()
    }
}
