# Short CLI recording for the README.
#
# From the repository root, after `pnpm build` (needs vhs, ttyd, git, node, jq):
#   vhs assets/demo/claims.tape
#
# Visible commands stay short. assets/demo/prepare.sh (sourced inside Hide)
# creates /tmp/shop, selects main mode, and wraps `kith begin` so the owner
# pid, client, and title are not typed. claim.jq prints one line from the
# real claim JSON and drops the session token. Commit and status are the
# CLI's own human text. The file edit happens in that hidden setup.

Output assets/demo/claims.gif

Require node
Require git
Require jq

Set Shell "bash"
Set FontFamily "JetBrains Mono"
Set FontSize 24
Set LineHeight 1.2
Set Width 1280
Set Height 760
Set Padding 28
Set Theme "Catppuccin Mocha"
Set TypingSpeed 50ms
Set Framerate 20
Set WindowBar Colorful

Hide
Type "source assets/demo/prepare.sh"
Enter
Type "clear"
Enter
Show

Type "# agent auth"
Enter
Type "kith begin --agent auth --scope src/auth.mjs"
Enter
Sleep 1.1s

Type "# agent billing"
Enter
Type "kith begin --agent billing --scope src/auth.mjs"
Enter
Sleep 1.8s
Screenshot assets/demo/refusal.png

Type "# agent auth"
Enter
Type "kith commit --agent auth -m 'Add a login check' src/auth.mjs"
Enter
Sleep 1.3s

Type "kith status"
Enter
Sleep 4.5s
Screenshot assets/demo/status.png
