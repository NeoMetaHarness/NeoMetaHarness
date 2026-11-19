# Isolated Chrome computer

Each attached computer starts headless Chrome with a disposable profile and speaks CDP over a private stdio pipe (`--remote-debugging-pipe`), so it opens no debugging port (SEC-06). Disabling the extension releases its computers and terminates the Chrome process tree.

Set `NMH_CHROME` to the Chrome binary path when it is installed in a nonstandard location. The provider exposes a `browserCdp` capability through `Computer.browser()` for trusted local integrations.
