# tunlite — hero demo (VHS tape)
#
# Render:
#   brew install vhs          # one-time (pulls ttyd + ffmpeg)
#   cd <repo root>            # run from the repo root so fixtures/ resolves
#   vhs docs/demo.tape        # writes docs/demo.gif
#
# Flow (the daemon is already running, off camera): define a tunnel -> the
# supervisor brings it up on its own -> a moment later check status -> tail the
# logs. Fully sandboxed: throwaway /tmp config + socket, fake autostart, and a
# fake `ssh` copied to a NEUTRAL /tmp path (the logs print the ssh binary path,
# and the repo path holds private identifiers). NEVER touches your real tunnels
# / launchd. Requires `tunlite` on PATH.

Output docs/demo.gif

Set Shell bash
Set FontSize 18
Set Width 1180
Set Height 680
Set Padding 26
Set TypingSpeed 55ms
Set Theme "Catppuccin Mocha"

# ---- hidden setup: daemon already up, off camera ----
Hide
Type 'mkdir -p /tmp/tunlite-demo && cp fixtures/fake-ssh.js /tmp/tunlite-demo/ssh && chmod +x /tmp/tunlite-demo/ssh' Enter
Type 'export TUNLITE_CONFIG=/tmp/_h_cfg.json TUNLITE_SOCKET=/tmp/_h_sock TUNLITE_FAKE_AUTOSTART=1' Enter
Type 'export TUNLITE_SSH=/tmp/tunlite-demo/ssh FAKE_SSH_MODE=stay FAKE_SSH_PROBE=0' Enter
Type 'tunlite daemon stop >/dev/null 2>&1; rm -f /tmp/_h_cfg.json /tmp/_h_sock' Enter
Type 'tunlite daemon start >/dev/null' Enter
Type 'clear' Enter
Show

# ---- 1. define a tunnel (the running daemon brings it up automatically) ----
Sleep 600ms
Type 'tunlite add db-5432 --to me@server -L 5432:localhost:5432' Sleep 600ms Enter

# ---- 2. a moment later, check status ----
Sleep 2.5s
Type 'tunlite status' Sleep 600ms Enter
Sleep 2.5s

# ---- 3. tail the logs ----
Type 'tunlite logs db-5432' Sleep 600ms Enter
Sleep 4s

# ---- teardown (hidden) ----
Hide
Type 'tunlite daemon stop >/dev/null 2>&1; rm -rf /tmp/_h_cfg.json /tmp/_h_sock /tmp/tunlite-demo' Enter
Show
