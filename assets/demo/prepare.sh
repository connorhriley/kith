# Sourced from the repository root by assets/demo/claims.tape.
# Expects dist/cli/index.js from `pnpm build`. Prepares /tmp/shop and a kith function.
# Do not execute this file: the function and the working directory have to stay in the tape's shell.

if [[ ! -f dist/cli/index.js ]]; then
  echo "Build the CLI first: pnpm build" >&2
  return 1 2>/dev/null || exit 1
fi

export KITH_SRC=$PWD
kith() { node "$KITH_SRC/dist/cli/index.js" "$@"; }
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
cp "$KITH_SRC/assets/demo/claim.jq" claim.jq
