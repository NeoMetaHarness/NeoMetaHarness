# Local desktop provider

`computer-local` is disabled by default. An owner must enable the extension and
separately opt in through `computers.local.set({ enabled: true })`. Attach the
single target `local-desktop` after opt-in. Disabling consent releases it and
stops its driver. The existing Computers page shows `computer.acting` events,
human takeover, and the global kill switch.

The driver interface is in `src/provider.ts`. The default adapter starts an
operator-installed executable at the absolute `NEO_CUA_DRIVER_PATH` with the
argument `--stdio-json`, using no shell. It exchanges newline-delimited JSON
`{id,method,params}` and `{id,result}` (or `{id,error}`), with methods
`screenshot`, `click`, `move`, `type`, `key`, `scroll`. Screenshot returns
`{png,width,height}` with a base64 PNG. The process is terminated on lease
takeover, consent revocation, kill, or extension disable. Local drivers should
return immediately when their process is terminated. No native driver is
installed or invoked by tests, which inject an in-memory fake.
