# Sourced from the repository root by assets/demo/claims.tape.
# Expects dist/cli/index.js from `pnpm build`. Prepares /tmp/shop.
# Do not execute this file: the kith wrapper has to stay in the tape's shell.
#
# The wrapper keeps the typed commands short. For `kith begin` it adds the
# owner pid, client, and title, then prints one line from the CLI JSON.
# Commit and status go to the real CLI, which already prints human text on a TTY.

if [[ ! -f dist/cli/index.js ]]; then
  echo "Build the CLI first: pnpm build" >&2
  return 1 2>/dev/null || exit 1
fi

export KITH_SRC=$PWD
mkdir -p /tmp/kith-bin
cat > /tmp/kith-bin/kith << EOF
#!/bin/sh
exec node "$KITH_SRC/dist/cli/index.js" "\$@"
EOF
chmod +x /tmp/kith-bin/kith
export PATH="/tmp/kith-bin:$PATH"

unset PROMPT_COMMAND
PS1='shop $ '

cd /tmp
rm -rf shop
mkdir shop
cd shop
git init -q -b main
git config user.email "demo@kith.local"
git config user.name "Kith demo"
mkdir -p src
printf '%s\n' 'export function login() { return false; }' > src/auth.mjs
printf '%s\n' 'export function charge() { return 0; }' > src/billing.mjs
printf '%s\n' '.coord/' > .gitignore
git add .
git commit -q -m "Initial modules"
kith mode main >/dev/null
# Auth's later commit records this edit. It stays off screen so the typed steps are the claims, the commit, and status.
printf '%s\n' 'export function login() { return true; }' > src/auth.mjs

kith() {
  if [[ "${1:-}" == begin ]]; then
    shift
    local agent="" scope="" title="Active work" client="cli"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --agent) agent=$2; shift 2 ;;
        --scope) scope=$2; shift 2 ;;
        *) shift ;;
      esac
    done
    case "$agent" in
      auth) title="Add a login check"; client="claude-code" ;;
      billing) title="Change the login check"; client="cursor" ;;
    esac
    command kith begin --agent "$agent" --client "$client" --owner-pid "$$" --title "$title" --scope "$scope" \
      | jq -r -f "$KITH_SRC/assets/demo/claim.jq"
    return "${PIPESTATUS[0]}"
  fi
  command kith "$@"
}
