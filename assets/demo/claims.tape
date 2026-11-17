# Short CLI recording for the README.
#
# From the repository root, after `pnpm build` (needs vhs, ttyd, git, node, jq):
#   vhs assets/demo/claims.tape
#
# The visible commands are the real CLI. `kith begin` is piped through claim.jq,
# which prints the claim fields and leaves out the session token. `--owner-pid $$`
# keeps each session on this shell; a pipe would otherwise bind the session to a
# subshell that exits before the next command.
#
# Setup is hidden. It creates /tmp/shop, a throwaway Git repository.

Output assets/demo/claims.gif

Require node
Require git
Require jq

Set Shell "bash"
Set FontFamily "JetBrains Mono"
Set FontSize 15
Set LineHeight 1.15
Set Width 1280
Set Height 680
Set Padding 18
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms
Set Framerate 20
Set WindowBar Colorful

Hide
Type "source assets/demo/prepare.sh"
Enter
Type "clear"
Enter
Show

Type "kith mode main"
Enter
Sleep 1.2s

Type "kith begin --agent auth --client claude-code --owner-pid $$ --title 'Add a login check' --scope src/auth.mjs | jq -f claim.jq"
Enter
Sleep 2.4s

Type "kith begin --agent billing --client cursor --owner-pid $$ --title 'Change the login check' --scope src/auth.mjs | jq -f claim.jq"
Enter
Sleep 4s
Screenshot assets/demo/refusal.png

Type "echo 'export function login() { return true; }' > src/auth.mjs"
Enter
Sleep 0.8s

Type "kith commit --agent auth -m 'Add a login check' src/auth.mjs"
Enter
Sleep 2.2s

Type "kith status"
Enter
Sleep 5s
Screenshot assets/demo/status.png
