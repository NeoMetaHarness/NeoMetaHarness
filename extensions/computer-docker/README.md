# Docker desktop provider

Enable `computer-docker` and call `computers.provision` with a locally available image, an optional `vncPort` (default 5900), and an optional `secretName` stored in the caller's workspace vault. The desktop image must expose an RFB 3.8 server at `vncPort` and accept its VNC password through the `VNC_PASSWORD` environment variable. The provider invokes Docker with `--pull=never` and publishes VNC only on `127.0.0.1` with a host-assigned port.

Use `computers.lease` with `holder: human` to hand the desktop to its owner and `holder: agent` to hand back. `computers.kill` pauses agent actions globally. `computers.terminate` forcibly kills and removes the owned Docker container; `computers.release` stops and removes it. Disabling the extension closes its VNC sessions and cleans up its containers. Desktop credentials are retrieved from workspace-scoped encrypted vault records and passed only in the Docker CLI subprocess environment.
