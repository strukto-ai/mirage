//! One shell's state beside its variables: the positional parameters of
//! the shell and of each function running, the special parameters, and the
//! `set` and `shopt` options.

use std::borrow::Cow;
use std::collections::HashMap;

use crate::vars::{Indexed, Store};

/// The IFS a shell splits on when IFS is unset: space, tab, newline.
pub const IFS_DEFAULT: &[u8] = b" \t\n";

#[derive(Clone, Debug)]
pub struct Shell {
    pub vars: Store,
    /// The shell's own positional parameters.
    pub positional: Vec<Vec<u8>>,
    /// Each running function's positional parameters, innermost last;
    /// a function sees its own, even none (`f` run bare has `$#` of 0).
    pub calls: Vec<Vec<Vec<u8>>>,
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
    /// The status of the last command substitution a statement ran, which
    /// an assignment-only statement reports as its own.
    pub substituted: Option<i32>,
    /// `${PIPESTATUS[@]}`: each stage's status in the last pipeline.
    pub pipe_status: Vec<i32>,
    /// `${FUNCNAME[@]}`: the running functions, innermost first; None
    /// once `unset FUNCNAME` made it an ordinary name.
    pub function_names: Option<Vec<Vec<u8>>>,
    /// The shell is a `( )` subshell, a compound command forked as a stage
    /// or job, or a fork of one, which a refused `${var:=word}` ends with 2.
    pub paren: bool,
}

impl Shell {
    pub fn new(vars: Store) -> Self {
        Self {
            vars,
            positional: Vec::new(),
            calls: Vec::new(),
            status: 0,
            pid: 0,
            last_job: None,
            argv0: b"mirage".to_vec(),
            options: HashMap::new(),
            shopts: HashMap::new(),
            env_limit: None,
            memory_room: None,
            outside: 0,
            substituted: None,
            pipe_status: Vec::new(),
            function_names: Some(Vec::new()),
            paren: false,
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
        self.calls.last().unwrap_or(&self.positional)
    }

    /// An indexed array by name: `PIPESTATUS` and `FUNCNAME` from the
    /// shell's own bookkeeping, which a lookup answers and an assignment
    /// never reaches, else the variable's.
    pub fn indexed(&self, name: &str) -> Option<Cow<'_, Indexed>> {
        if self.vars.hidden(name) {
            return None;
        }
        match (name, &self.function_names) {
            ("PIPESTATUS", _) => Some(Cow::Owned(Indexed::dense(
                self.pipe_status
                    .iter()
                    .map(|status| status.to_string().into_bytes()),
            ))),
            ("FUNCNAME", Some(names)) => Some(Cow::Owned(Indexed::dense(names.iter().cloned()))),
            _ => self.vars.indexed(name).map(Cow::Borrowed),
        }
    }

    /// The IFS in scope, None when it is unset, which splits as the
    /// default does.
    pub fn ifs(&self) -> Option<&[u8]> {
        self.vars.scalar("IFS")
    }

    /// The home directory `~` names: `$HOME`, None when unset or empty.
    pub fn home(&self) -> Option<&[u8]> {
        self.vars.scalar("HOME").filter(|home| !home.is_empty())
    }

    /// Whether characters are UTF-8 here, as setlocale reads it: the
    /// first of `LC_ALL`, `LC_CTYPE` and `LANG` that is set and not empty
    /// names a `language[_territory][.codeset][@modifier]` whose codeset,
    /// case and punctuation dropped, is `utf8`. Otherwise a character is a
    /// byte, as in the C locale.
    pub fn utf8(&self) -> bool {
        ["LC_ALL", "LC_CTYPE", "LANG"]
            .iter()
            .find_map(|name| self.vars.scalar(name).filter(|value| !value.is_empty()))
            .is_some_and(|locale| {
                let name = locale.split(|&b| b == b'@').next().unwrap_or_default();
                let codeset = name
                    .iter()
                    .position(|&b| b == b'.')
                    .map_or(&[][..], |dot| &name[dot + 1..]);
                let folded: Vec<u8> = codeset
                    .iter()
                    .filter(|b| b.is_ascii_alphanumeric())
                    .map(u8::to_ascii_lowercase)
                    .collect();
                folded == b"utf8"
            })
    }
}
