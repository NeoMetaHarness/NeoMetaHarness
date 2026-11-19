# Orgo cloud computer provider

Enable **computer-orgo** in Extensions. Open Settings for this extension, save the Orgo workspace UUID and API key. The key is stored by the kernel in the vault as `SEC_APIKEY` for the `computer-orgo` engine scope and is never included in the settings API response.

Provision a computer using `computers.provision({ providerId: 'computer-orgo', spec: {} })` from an authenticated workspace. Optional spec fields are `os` (linux, windows, macos), `ram` and `cpu`. Orgo computers created by this provider are stopped on release and deleted on terminate. External Orgo UUIDs can be attached and detached without stopping them.

The provider uses Orgo's REST endpoint at https://www.orgo.ai/api. Live calls require an operator-configured account and may incur Orgo usage charges. Tests inject a client pointing only to a randomized loopback server. Shared computer safety, leases, kill switch and action audits are enforced by ComputerRegistry.
