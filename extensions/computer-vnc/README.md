# VNC computer provider

Minimal TypeScript RFB 3.8 client, without a VNC dependency. Enable `computer-vnc`
and use **Computers → Attach VNC**, or the existing admin/owner
`computers.attach` route with `providerId: "computer-vnc"` and
`target: "host:5900#VNC_PASSWORD"` (IPv6: `[::1]:5900#VNC_PASSWORD`). Store
`VNC_PASSWORD` in the authenticated workspace's workspace-scoped vault. The target
contains the secret's name, never its value. The Gateway supplies workspace identity;
the target cannot select another workspace. Provisioning is unsupported.

Omit `#SECRET` only for a server intentionally configured for None security.
Supplying a secret requires VNC authentication; the client refuses a downgrade to
None. Classic VNC uses only the first eight Latin-1 password bytes. Neither None
nor VNC authentication encrypts screen/input traffic; use a trusted network or an
SSH/TLS tunnel to the server. There is no TLS, VeNCrypt or extended-security support.

RFC 6143 sections 7.1–7.3 cover negotiation and authentication; 7.4.1–7.4.5 cover
pixel format, encodings, updates, keys and pointer input; 7.5.1 and 7.6.1–7.6.2
define framebuffer updates, Raw and CopyRect. Source comments cite these sections.
The client requests little-endian RGB888, exposes PNG captures to Neo's existing
viewer, and supports click, move, type, key chords and wheel input. Unicode typing
uses X11 Unicode keysyms; server keyboard support determines the resulting text.

Framebuffer storage is bounded to 16,777,216 pixels; TCP buffers, desktop names,
clipboard messages and rectangle counts are bounded. Unsupported versions,
encodings or resize messages fail explicitly. A timeout or drop closes the client;
release and reattach to reconnect. Release/disable aborts active and pending sockets.
Leases, assignments, acting events and kill-switch checks belong to the computer
registry. No new RPC routes or policy entries are needed: this provider reuses
the existing `computers.*` and scoped internal-action policies.

`pnpm --dir extensions/computer-vnc test` runs local protocol tests against the
independent fake RFB server. `pnpm test:p3-4` builds the app first, then verifies
authenticated attachment, vault isolation, pixels, bot input, the viewer, kill
switch, release/disable and healthy sibling extensions with no real VNC server.
