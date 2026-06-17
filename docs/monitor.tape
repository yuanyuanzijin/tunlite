# tunlite — `monitor` live dashboard (VHS tape)
#
# Produces THREE assets in one run:
#   docs/monitor.gif          the animated dashboard (list -> detail -> live restart)
#   docs/monitor-list.png     still: the dashboard (3 connected + 1 auto-reconnecting)
#   docs/monitor-detail.png   still: a tunnel's detail view (settings + reconnect logs)
#
# Render:
#   brew install vhs
#   cd <repo root>          # so fixtures/demo-ssh.js resolves
#   vhs docs/monitor.tape
#
# Sandboxed: throwaway /tmp config + socket, fake autostart, and a host-aware
# fake `ssh` (copied to a NEUTRAL /tmp path — the detail logs print the ssh
# binary path, and the repo path holds private identifiers). One daemon shows a
# clean mix: 3 connected + 1 retrying (auto-reconnect). Never touches your real
# tunnels / launchd. Requires `tunlite` on PATH.

Output docs/monitor.gif

Set Shell bash
Set FontSize 18
Set Width 1200
Set Height 760
Set Padding 26
Set TypingSpeed 55ms
Set Theme "Catppuccin Mocha"

# ---- hidden sandbox setup (fully hidden: no inline `sleep`, so the shell is
#      free when `clear` is typed and the entry into monitor is clean) ----
Hide
Type 'mkdir -p /tmp/tunlite-demo && cp fixtures/demo-ssh.js /tmp/tunlite-demo/ssh && chmod +x /tmp/tunlite-demo/ssh' Enter
Type 'export TUNLITE_CONFIG=/tmp/_mon_cfg.json TUNLITE_SOCKET=/tmp/_mon_sock TUNLITE_FAKE_AUTOSTART=1 TUNLITE_SSH=/tmp/tunlite-demo/ssh' Enter
Type 'tunlite daemon stop >/dev/null 2>&1; rm -f /tmp/_mon_cfg.json /tmp/_mon_sock' Enter
Type 'tunlite add local   web-8080   --to me@web    --remote 80   --local 8080 >/dev/null' Enter
Type 'tunlite add local   db-5432    --to me@db     --remote 5432 --local 5432 >/dev/null' Enter
Type 'tunlite add dynamic socks-1080 --to me@bastion                           >/dev/null' Enter
Type 'tunlite add local   api-3000   --to me@flap   --remote 3000 --local 3000 >/dev/null' Enter
Type 'tunlite up >/dev/null 2>&1' Enter
Sleep 3s
Type 'clear' Enter
Show

# ---- the live dashboard ----
Type 'tunlite monitor' Sleep 600ms Enter
Sleep 6s
Screenshot docs/monitor-list.png

# drill into the retrying tunnel -> its reconnect logs
Type 'j' Sleep 450ms
Type 'j' Sleep 450ms
Type 'j' Sleep 450ms
Enter
Sleep 3s
Screenshot docs/monitor-detail.png

# back to the list, restart a healthy tunnel to show live control (r -> y)
Escape
Sleep 1s
Type 'k' Sleep 400ms
Type 'k' Sleep 400ms
Type 'r' Sleep 900ms
Type 'y'
Sleep 4s

# ---- teardown (hidden): quit monitor, stop daemon, clean tmp ----
Hide
Type 'q'
Sleep 800ms
Type 'tunlite daemon stop >/dev/null 2>&1; rm -rf /tmp/_mon_cfg.json /tmp/_mon_sock /tmp/tunlite-demo' Enter
Sleep 800ms
Show
