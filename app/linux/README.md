# LOCKqz on Linux (28 Oct 2026)

Same product as the Mac: a root helper (`lockqzd.service`, the shared `lockqzd.py` with `LOCKQZ_PLATFORM=linux`)
and a per-user agent (`lockqz-agent.service`, a systemd user unit enabled for every account) that reuses the
Mac agent's quiz logic (`agent-mac.py`) with Linux pieces (`lockqz-agent.py`).

Install: `curl -fsSL https://lockqz.pages.dev/install-linux.sh | sudo bash` (Ubuntu, Debian, Fedora, Arch -
anything with systemd + python3). Files: `/usr/local/lib/lockqz`; state: `/var/lib/lockqz`.

Lock layers (`lockqz.sh`): /etc/hosts blackhole (shared `lockqz-core.sh`); nftables (iptables fallback) for
DNS-over-TLS, DoH resolver addresses, local-model ports, VPN protocols, QUIC to the AI hosts' addresses;
browser policies (`browser-policy.py` writes the Mac module's policies as managed JSON for Chrome, Chromium
deb/snap, Edge, Brave, Vivaldi, Opera and `policies.json` for the Firefox family); AI / local-model / VPN /
VM / remote-desktop / overlay / messaging apps closed; connections already open to AI hosts cut (`ss -K`)
from the resolved address list (`browser-policy.py resolve`, raw DNS past /etc/hosts, every 12 h).

Tabs: Firefox family from `recovery.jsonlz4` (deb, snap, flatpak), Chromium family from the SNSS session file
(`Sessions/Session_*`). Browsers that read policies only at start (Firefox family) or have none (Opera,
Vivaldi, flatpak builds) are closed at lock unless they hold the quiz.

Phones, iPads, Android and Chromebooks cannot run LOCKqz (no self-installed program may block
other apps there; a school-managed device is the only route).
