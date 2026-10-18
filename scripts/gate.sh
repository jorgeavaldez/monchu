#!/usr/bin/env bash
# Run the full gate (`mise run check` and `mise run build`) on a revision or on a
# working copy streamed in as a tar, in a dedicated jj clone of this repository.
#
#   scripts/gate.sh [REV]   fetch, then gate REV (default main@origin)
#   scripts/gate.sh -       gate the tar of a working copy read from stdin, e.g.
#                           jj file list | tar -cf - -T - | ssh HOST CLONE/scripts/gate.sh -
#
# Runs are serialized with a lock and happen in a sibling jj workspace (CLONE-run),
# so node_modules and build outputs carry over between runs. Before each run the
# clone itself moves to the fetched main, so this script stays current.
# Prints a short summary, the tail of a failure, and the full log's path.
# Exits 0 only when every gate passed.
set -euo pipefail

main() {
  local root run logs target log status
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  run="${GATE_RUN_DIR:-$root-run}"
  logs="${GATE_LOG_DIR:-$root-logs}"
  target="${1:-main@origin}"
  # Non-interactive ssh shells often lack the user's mise activation.
  command -v mise > /dev/null || PATH="$HOME/.local/bin:$PATH"
  mise trust --quiet "$root"
  eval "$(cd "$root" && mise env -s bash)"

  mkdir -p "$logs"
  exec 9> "$logs/.lock"
  if ! flock -n 9; then
    echo "gate: waiting for another run to finish"
    flock 9
  fi

  cd "$root"
  jj git fetch --quiet
  jj new --quiet main@origin
  [ -d "$run" ] || jj workspace add --quiet --name gate-run "$run"

  cd "$run"
  jj workspace update-stale --quiet 2> /dev/null || true
  # Drop a previous stdin run's working copy instead of leaving it as a head.
  if [ -n "$(jj log --no-graph -r '@ ~ empty()' -T 'change_id')" ]; then
    jj abandon --quiet @
  fi
  if [ "$target" = "-" ]; then
    jj new --quiet main@origin
    jj file list | xargs -d '\n' rm -f
    # A directory a previous run left empty (a plugin dir, say) changes what the tests load.
    find . -mindepth 1 \( -name .jj -o -name .git -o -name node_modules \) -prune -o -type d -empty -delete
    tar -xf -
    target="stdin working copy"
  else
    jj new --quiet "$target"
  fi
  local desc
  desc="$(jj log --no-graph -r '@-' -T 'commit_id.short(12) ++ " " ++ description.first_line()')"

  log="$logs/$(date +%Y%m%d-%H%M%S).log"
  {
    echo "gate: $target"
    echo "base: $desc"
    jj status
  } > "$log"
  mise trust --quiet "$run"
  eval "$(mise env -s bash)"
  status=0
  # -c reports every gate, not only the first failure; -j 1 keeps the box responsive.
  mise run --continue-on-error --jobs 1 check ::: build >> "$log" 2>&1 || status=$?
  # Keep the newest 30 logs.
  printf '%s\n' "$logs"/*.log | sort -r | tail -n +31 | xargs -r -d '\n' rm -f

  echo "gate: $target"
  echo "base: $desc"
  grep -E '^\[[a-z:-]+\] \$ ' "$log" | sed -E 's/^\[([a-z:-]+)\] \$ (.*)/ran  \1: \2/' || true
  if [ "$status" -eq 0 ]; then
    echo "PASS"
  else
    echo "--- tail ---"
    sed -E 's/\x1b\[[0-9;]*m//g' "$log" | grep -vE '(✓|↓|npm notice)' | tail -n 40
    echo "FAIL (exit $status)"
  fi
  echo "log: $log"
  return "$status"
}

# One line: bash has read it before the run updates this file.
main "$@"; exit
