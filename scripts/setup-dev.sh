#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
bin_dir="${HOME}/.local/bin"
codex_ui_dev="${bin_dir}/codex-ui-dev"
pnpm_version="${PNPM_VERSION:-9}"
pnpm_major="${pnpm_version%%.*}"

if ! command -v node >/dev/null 2>&1; then
  echo "node is required" >&2
  exit 1
fi

mkdir -p "$bin_dir"

run_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm --dir "$root" "$@"
  elif command -v corepack >/dev/null 2>&1; then
    corepack pnpm --dir "$root" "$@"
  elif command -v npm >/dev/null 2>&1; then
    npm exec --yes "pnpm@${pnpm_version}" -- --dir "$root" "$@"
  else
    echo "pnpm, corepack, or npm is required" >&2
    exit 1
  fi
}

install_args=(install)
modules_yaml="${root}/node_modules/.modules.yaml"
if [[ -d "${root}/node_modules" ]]; then
  if [[ ! -f "$modules_yaml" ]] ||
    ! grep -Eq "^[[:space:]]*(\"packageManager\": \"|packageManager: )pnpm@${pnpm_major}\\." "$modules_yaml"; then
    install_args+=(--force)
  fi
fi

run_pnpm "${install_args[@]}"

cat >"$codex_ui_dev" <<EOF
#!/usr/bin/env bash
set -euo pipefail

root="$root"

if [[ "\${1:-}" == "--" ]]; then
  shift
fi

if command -v pnpm >/dev/null 2>&1; then
  pnpm_cmd=(pnpm)
  exec "\${pnpm_cmd[@]}" --dir "\$root" run dev -- "\$@"
elif command -v corepack >/dev/null 2>&1; then
  exec corepack pnpm --dir "\$root" run dev -- "\$@"
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
