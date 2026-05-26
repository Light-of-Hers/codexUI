#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
bin_dir="${HOME}/.local/bin"
codex_ui_dev="${bin_dir}/codex-ui-dev"

if ! command -v node >/dev/null 2>&1; then
  echo "node is required" >&2
  exit 1
fi

mkdir -p "$bin_dir"

if command -v pnpm >/dev/null 2>&1; then
  pnpm_cmd=(pnpm)
  "${pnpm_cmd[@]}" --dir "$root" install
elif command -v corepack >/dev/null 2>&1; then
  corepack pnpm --dir "$root" install
elif command -v npm >/dev/null 2>&1; then
  npm install --no-package-lock --prefix "$root"
else
  echo "pnpm, corepack, or npm is required" >&2
  exit 1
fi

cat >"$codex_ui_dev" <<EOF
#!/usr/bin/env bash
set -euo pipefail

root="$root"

if command -v pnpm >/dev/null 2>&1; then
  pnpm_cmd=(pnpm)
  exec "\${pnpm_cmd[@]}" --dir "\$root" run dev "\$@"
elif command -v corepack >/dev/null 2>&1; then
  exec corepack pnpm --dir "\$root" run dev "\$@"
elif command -v npm >/dev/null 2>&1; then
  cd "\$root"
  exec npm run dev -- "\$@"
else
  echo "pnpm, corepack, or npm is required" >&2
  exit 1
fi
EOF

chmod +x "$codex_ui_dev"

echo "Configured development command:"
echo "  codex-ui-dev"
