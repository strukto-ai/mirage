use super::*;

/// The scope a function call or a prefix assignment opens: the records it
/// shadowed, None for a name that had none. `temp` marks a prefix
/// assignment's scope, bash's temporary environment of `x=1 f`.
#[derive(Clone, Debug, Default)]
pub(super) struct Frame {
    pub(super) saved: HashMap<String, Option<Arc<Var>>>,
    pub(super) temp: bool,
}

impl Store {
    /// The innermost scope on the call path that saved `name`.
    fn shadowing(&self, name: &str) -> Option<usize> {
        self.frames
            .iter()
            .rposition(|frame| frame.saved.contains_key(name))
    }

    /// Drop a variable as `unset` does. A name the running function made
    /// local stays unset until it returns; a name an enclosing scope
    /// shadows is that scope's to lose: the unset reveals the value it
    /// saved, which the name holds from then on (`x=old; x=pre f` where f
    /// runs `unset x` reads `old` inside f and after it).
    pub fn drop_var(&mut self, name: &str) {
        match self.shadowing(name) {
            Some(index) if Some(index) != self.local && name != RANDOM => {
                let saved = self.frames[index].saved.remove(name).flatten();
                self.place(name, saved);
            }
            _ => {
                self.place(name, None);
            }
        }
        if name == RANDOM {
            self.random_seed = Seed::Off;
        }
        self.plain
            .retain(|held| held != PIPESTATUS || name != PIPESTATUS);
        self.make_plain(name);
    }

    /// Open a function's scope; returns the caller's, for `leave`.
    pub fn enter(&mut self) -> Option<usize> {
        let outer = self.local;
        self.local = Some(self.frames.len());
        self.frames.push(Frame::default());
        outer
    }

    /// Close the running function's scope: its shadowed records come back,
    /// a local `RANDOM` hands the caller's generator back, and a local
    /// `LINENO` or `BASHPID` the meaning the caller's had. Deliberate
    /// divergence: bash reseeds the generator there; mirage resumes the
    /// caller's sequence where it left off. An `outer` scope no frame
    /// holds is the top level.
    pub fn leave(&mut self, outer: Option<usize>) {
        if let Some(frame) = self.frames.pop() {
            let random = frame.saved.contains_key(RANDOM);
            let specials = [LINENO, BASHPID]
                .iter()
                .filter(|name| frame.saved.contains_key(**name))
                .count();
            for (name, old) in frame.saved {
                self.place(&name, old);
            }
            if random {
                self.random_seed = self.local_random.pop().unwrap_or(Seed::Fresh);
            }
            for (name, plain) in self
                .local_plain
                .split_off(self.local_plain.len().saturating_sub(specials))
            {
                self.plain.retain(|held| *held != name);
                if plain {
                    self.plain.push(name);
                }
            }
        }
        self.local = outer.filter(|&index| index < self.frames.len());
    }

    /// Whether a function is running.
    pub fn in_function(&self) -> bool {
        self.local.is_some()
    }

    /// The names the running function made local, sorted; none at top
    /// level.
    pub fn locals(&self) -> Vec<String> {
        let mut names: Vec<String> = self
            .local
            .map(|index| self.frames[index].saved.keys().cloned().collect())
            .unwrap_or_default();
        names.sort();
        names
    }

    /// Whether the running function made `name` local already.
    pub fn is_local(&self, name: &str) -> bool {
        self.local
            .is_some_and(|index| self.frames[index].saved.contains_key(name))
    }

    /// Record the caller's record before a `local` shadows it, once per
    /// scope. A local `RANDOM` is an ordinary variable for the function's
    /// extent (`local RANDOM=5; echo $RANDOM` prints 5), and so is a local
    /// `LINENO` or `BASHPID`, its `unset` the function's own, unless `-I`
    /// (`inherit`) keeps the meaning the caller's has.
    pub fn shadow(&mut self, name: &str, inherit: bool) {
        let Some(index) = self.local else {
            return;
        };
        if self.frames[index].saved.contains_key(name) {
            return;
        }
        let old = self.vars.get(name).cloned();
        self.frames[index].saved.insert(name.to_owned(), old);
        if name == RANDOM {
            let seed = std::mem::replace(&mut self.random_seed, Seed::Off);
            self.local_random.push(seed);
        } else if name == LINENO || name == BASHPID {
            let plain = self.plain.iter().any(|held| held == name);
            self.local_plain.push((name.to_owned(), plain));
            if !inherit {
                self.make_plain(name);
            }
        }
    }

    /// Open a prefix assignment's scope (`x=1 f`): the names it assigns
    /// are put back when `close_temp` closes it.
    pub fn open_temp(&mut self) -> usize {
        self.frames.push(Frame {
            temp: true,
            ..Frame::default()
        });
        self.frames.len() - 1
    }

    /// Save `name`'s record in the prefix scope `index`, once; an index no
    /// frame holds saves nothing.
    pub fn save_temp(&mut self, index: usize, name: &str) {
        let Some(frame) = self.frames.get_mut(index) else {
            return;
        };
        if !frame.saved.contains_key(name) {
            frame
                .saved
                .insert(name.to_owned(), self.vars.get(name).cloned());
        }
    }

    /// Close prefix scope `index`, putting back what it saved.
    pub fn close_temp(&mut self, index: usize) {
        if index < self.frames.len() {
            let frame = self.frames.remove(index);
            for (name, old) in frame.saved {
                self.place(&name, old);
            }
        }
    }

    /// Let a temporary-environment variable outlive its call: bash keeps
    /// `x` from `x=1 f` once something inside runs `export x` or
    /// `readonly x`.
    pub fn outlive_call(&mut self, name: &str) {
        if let Some(index) = self
            .shadowing(name)
            .filter(|&index| self.frames[index].temp)
        {
            self.frames[index].saved.remove(name);
        }
    }

    /// Whether the running function's call assigned `name` in front.
    pub fn in_call_env(&self, name: &str) -> bool {
        self.local.is_some_and(|index| {
            index > 0
                && self.frames[index - 1].temp
                && self.frames[index - 1].saved.contains_key(name)
        })
    }

    /// Put each name's global record in place for a `declare -g`: the
    /// running local lives in the store and the global is what the
    /// outermost shadowing scope saved, so the two swap until `unreach`
    /// (`local G=5; declare -gr G=1` leaves `$G` at 5 in the function, 1
    /// and frozen outside).
    pub fn reach_global(&mut self, names: &[String]) {
        let mut seen = HashSet::new();
        let mut reached = Vec::new();
        for name in names {
            if !seen.insert(name) {
                continue;
            }
            let Some(index) = self.frames.iter().position(|f| f.saved.contains_key(name)) else {
                continue;
            };
            let global = self.frames[index].saved.get(name).cloned().flatten();
            let running = self.place(name, global);
            reached.push((name.clone(), index, running));
        }
        self.reached = reached;
    }

    /// Put the running locals back after a `declare -g`.
    pub fn unreach(&mut self) {
        for (name, index, running) in std::mem::take(&mut self.reached) {
            let global = self.share(&name);
            if let Some(frame) = self.frames.get_mut(index) {
                frame.saved.insert(name.clone(), global);
            }
            self.place(&name, running);
        }
    }

    /// Put the locals a running `declare -g` set aside back for one
    /// arithmetic evaluation, which reads the function's scope as bash's
    /// does (`local H=2; declare -gi G=H` stores 2); `step_forward` reaches
    /// the globals again, keeping what the evaluation gave the locals.
    pub fn step_back(&mut self) -> Vec<(String, Option<Arc<Var>>)> {
        let reached: Vec<(String, Option<Arc<Var>>)> = self
            .reached
            .iter()
            .map(|(name, _, _)| (name.clone(), self.share(name)))
            .collect();
        let running: Vec<(String, Option<Arc<Var>>)> = self
            .reached
            .iter()
            .map(|(name, _, running)| (name.clone(), running.clone()))
            .collect();
        for (name, var) in running {
            self.place(&name, var);
        }
        reached
    }

    pub fn step_forward(&mut self, globals: Vec<(String, Option<Arc<Var>>)>) {
        for entry in self.reached.iter_mut() {
            entry.2 = self.vars.get(entry.0.as_str()).cloned();
        }
        for (name, var) in globals {
            self.place(&name, var);
        }
    }
}
