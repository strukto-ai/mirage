export const UseCaseTerminal = ({ services, steps }) => {
  const [pos, setPos] = useState({ step: steps.length, chars: 0, output: true })

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return undefined
    }
    let timer
    let step = 0
    let chars = 0
    const tick = () => {
      if (step >= steps.length) {
        setPos({ step: steps.length, chars: 0, output: true })
        timer = setTimeout(() => {
          step = 0
          chars = 0
          tick()
        }, 2000)
        return
      }
      const cmd = steps[step].cmd
      if (chars < cmd.length) {
        chars += 1
        setPos({ step, chars, output: false })
        timer = setTimeout(tick, 12)
        return
      }
      setPos({ step, chars, output: true })
      timer = setTimeout(() => {
        step += 1
        chars = 0
        tick()
      }, 1000)
    }
    setPos({ step: 0, chars: 0, output: false })
    timer = setTimeout(tick, 300)
    return () => clearTimeout(timer)
  }, [])

  const active = pos.step < steps.length ? steps[pos.step].cli : null
  const state = (service) => (!active ? "" : active === service.cli ? " uct-on" : " uct-off")
  const tokens = (text) => {
    const out = []
    let command = true
    for (const part of text.match(/"[^"]*"?|'[^']*'?|\$\w+|\s+|[;&|>]+|[^\s;&|>"']+/g) || []) {
      let kind = "plain"
      if (/^\s+$/.test(part)) kind = "plain"
      else if (part.startsWith('"') || part.startsWith("'")) kind = "string"
      else if (part.startsWith("$")) kind = "variable"
      else if (/^[;&|>]+$/.test(part)) {
        kind = "operator"
        command = true
      } else if (part.startsWith("-")) kind = "flag"
      else if (command) {
        kind = "command"
        command = false
      }
      out.push([part, kind])
    }
    return out
  }
  const colored = (text, key) =>
    tokens(text).map(([part, kind], index) => (
      <span key={`${key}-${index}`} className={`uct-${kind}`}>
        {part}
      </span>
    ))

  const icons = {
    folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
    terminal: <path d="M4 17l6-5-6-5M12 19h8" />,
    mail: <path d="M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm-2 2 9 6 9-6" />,
  }

  return (
    <div className="use-case-terminal not-prose my-6 rounded-2xl">
      <style>{`
        .use-case-terminal {
          --uct-paper: #f0ece2; --uct-surface: #faf8f2; --uct-edge: #cec6b3;
          --uct-ink: #0a0a0a; --uct-muted: #5b5647; --uct-accent: #047857; --uct-on: #b08a2e;
          background: var(--uct-paper); color: var(--uct-ink); padding: 28px 14px;
        }
        html.dark .use-case-terminal {
          --uct-paper: #0e0e10; --uct-surface: #1a1a1d; --uct-edge: #3f3f46;
          --uct-ink: #ffffff; --uct-muted: #a1a1aa; --uct-accent: #34d399; --uct-on: #c9a03e;
        }
        .use-case-terminal img { margin: 0; display: block; }
        .use-case-terminal .uct-box { background: var(--uct-surface); border: 1px solid var(--uct-edge); }
        .use-case-terminal .uct-muted { color: var(--uct-muted); }
        .use-case-terminal .uct-grid { display: grid; gap: 10px; grid-template-columns: minmax(0, 1fr); }
        .use-case-terminal .uct-brand { order: -2; margin-bottom: 2px; }
        .use-case-terminal .uct-server { order: -1; }
        .use-case-terminal .uct-wire { display: none; }
        .use-case-terminal .uct-card { transition: opacity .3s, border-color .3s; }
        .use-case-terminal .uct-card.uct-on { border-color: var(--uct-on); }
        .use-case-terminal .uct-card.uct-off { opacity: .55; }
        .use-case-terminal .uct-wire-line { position: absolute; left: 0; right: 0; top: 50%; border-top: 1px solid var(--uct-edge); transition: border-color .3s; }
        .use-case-terminal .uct-wire.uct-on .uct-wire-line { border-color: var(--uct-on); }
        .use-case-terminal .uct-bar { border-bottom: 1px solid var(--uct-edge); }
        .use-case-terminal .uct-light { width: 8px; height: 8px; border-radius: 9999px; border: 1px solid var(--uct-edge); }
        .use-case-terminal .uct-prompt { color: var(--uct-accent); }
        .use-case-terminal .uct-caret { display: inline-block; width: 7px; height: 14px; margin-left: 1px; vertical-align: -2px; background: var(--uct-ink); animation: uct-blink 1s steps(1) infinite; }
        @keyframes uct-blink { 50% { opacity: 0; } }
        .use-case-terminal .uct-later { visibility: hidden; }
        .use-case-terminal .uct-operator { color: #cf222e; }
        .use-case-terminal .uct-command { color: #953800; }
        .use-case-terminal .uct-flag { color: #0550ae; }
        .use-case-terminal .uct-string { color: #0a3069; }
        .use-case-terminal .uct-variable { color: #8250df; }
        html.dark .use-case-terminal .uct-operator { color: #ff7b72; }
        html.dark .use-case-terminal .uct-command { color: #ffa657; }
        html.dark .use-case-terminal .uct-flag { color: #79c0ff; }
        html.dark .use-case-terminal .uct-string { color: #a5d6ff; }
        html.dark .use-case-terminal .uct-variable { color: #d2a8ff; }
        .use-case-terminal .uct-dark-only { display: none; }
        html.dark .use-case-terminal .uct-dark-only { display: block; }
        html.dark .use-case-terminal .uct-light-only { display: none; }
        html.dark .use-case-terminal .uct-invert { filter: invert(1); }
        .use-case-terminal .uct-logo { width: 18px; height: 18px; flex: none; color: var(--uct-muted); }
        @media (min-width: 640px) {
          .use-case-terminal { padding: 36px 28px; }
          .use-case-terminal .uct-grid {
            grid-template-columns: minmax(0, 1fr) 48px minmax(0, 2fr);
            grid-auto-rows: auto;
            align-items: center;
            column-gap: 0;
          }
          .use-case-terminal .uct-server { order: 0; grid-column: 3; grid-row: 2 / span var(--uct-span); align-self: stretch; display: flex; flex-direction: column; }
          .use-case-terminal .uct-term { flex: 1; }
          .use-case-terminal .uct-brand { order: 0; grid-column: 3; grid-row: 1; margin-bottom: 10px; }
          .use-case-terminal .uct-wire { display: block; position: relative; height: 12px; grid-column: 2; grid-row: var(--uct-row); }
          .use-case-terminal .uct-card { grid-column: 1; grid-row: var(--uct-row); }
        }
      `}</style>

      <div className="uct-grid">
        {services.map((service, index) => [
          <div
            key={index + "-card"}
            className={"uct-card uct-box flex items-center gap-2.5 rounded-lg px-3 py-2" + state(service)}
            style={{ "--uct-row": index + 2 }}
          >
            {service.logo ? (
              <img src={service.logo} alt="" className={"uct-logo" + (service.invert ? " uct-invert" : "")} />
            ) : (
              <svg className="uct-logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {icons[service.icon]}
              </svg>
            )}
            <div className="min-w-0">
              <div className="text-sm font-medium">{service.name}</div>
              {service.text && <div className="uct-muted text-xs">{service.text}</div>}
            </div>
          </div>,
          <div
            key={index + "-wire"}
            className={"uct-wire" + (active === service.cli ? " uct-on" : "")}
            style={{ "--uct-row": index + 2 }}
            aria-hidden="true"
          >
            <div className="uct-wire-line" />
          </div>,
        ])}

        <div className="uct-brand">
          <img src="/logo/light.svg" alt="mirage" className="uct-light-only" style={{ height: 32, width: "auto" }} />
          <img src="/logo/dark.svg" alt="mirage" className="uct-dark-only" style={{ height: 32, width: "auto" }} />
        </div>

        <div className="uct-server" style={{ "--uct-span": services.length }}>
          <div className="uct-term uct-box overflow-hidden rounded-lg">
            <div className="uct-bar flex items-center gap-1.5 px-3 py-2">
              <span className="uct-light" />
              <span className="uct-light" />
              <span className="uct-light" />
            </div>
            <div className="px-3 py-2 font-mono text-xs leading-5">
              {steps.map((step, index) => {
                const later = index > pos.step
                const current = index === pos.step
                const text = current ? step.cmd.slice(0, pos.chars) : step.cmd
                const showOut = index < pos.step || (current && pos.output)
                return (
                  <div key={step.cmd} className={later ? "uct-later" : ""}>
                    <div className="overflow-hidden text-ellipsis whitespace-nowrap">
                      <span className="uct-prompt select-none">$ </span>
                      {colored(later ? step.cmd : text, index)}
                      {current && !pos.output && <span className="uct-caret" />}
                    </div>
                    <div className={"uct-muted overflow-hidden text-ellipsis whitespace-nowrap" + (showOut || later ? "" : " uct-later")}>
                      {step.out}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
