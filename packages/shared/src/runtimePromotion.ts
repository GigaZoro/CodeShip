export const runtimePromotion = `# Runtime promotion, also embedded in the SSH bootstrap and service installer.
t3_restore_runtime() {
  # The rollback name differs from the version. BSD mv would nest it inside a
  # concurrent install; macOS ships Perl's rename(2), and Linux mv has -T.
  case "$(uname -s)" in
    Darwin) if perl -e 'exit(rename($ARGV[0], $ARGV[1]) ? 0 : 1)' -- "$1" "$t3_root"; then return 0; fi ;;
    *) if mv -T -- "$1" "$t3_root"; then return 0; fi ;;
  esac
  # An independent publisher may have won the rename. Keep the backup intact.
  t3_runtime_ready "$t3_root" "$t3_version"
}

t3_release_lock() {
  if [ -n "$t3_claim_dir" ] && [ -f "$t3_claim_dir/$$" ]; then
    if [ -n "\${t3_displaced:-}" ]; then
      if [ ! -e "$t3_staged" ] && [ -d "$t3_root" ]; then
        rm -rf "$t3_displaced" "$t3_previous" || return 1
      elif [ -d "$t3_displaced" ]; then
        if [ "$t3_reused" = 1 ] || t3_restore_runtime "$t3_displaced"; then
          if [ "$t3_displaced" != "$t3_previous" ]; then rm -rf "$t3_displaced" || return 1; fi
        else
          printf 'Could not restore runtime; kept %s\\n' "$t3_displaced" >&2
        fi
      fi
    fi
    if [ "$t3_root.lock" -ef "$t3_claim_dir/$$" ]; then rm -f "$t3_root.lock" || return 1; fi
    if [ "$t3_legacy_lock" -ef "$t3_claim_dir/$$" ]; then rm -f "$t3_legacy_lock" || return 1; fi
    rm -f "$t3_claim_dir/$$" || return 1
    rmdir "$t3_claim_dir" 2>/dev/null || :
  fi
  if [ -n "$t3_contender" ]; then rm -rf "$t3_contender"; fi
}

t3_acquire_lock() {
  t3_displaced=
  t3_parent=$1
  t3_version=$2
  t3_limit=$3
  t3_root="$t3_parent/$t3_version"
  t3_previous="$t3_parent/.$t3_version.previous"
  t3_name=".$t3_version.install.claim"
  t3_claim_dir="$t3_parent/$t3_name"
  t3_legacy_lock="$t3_parent/.$t3_version.install.lock"
  t3_contender=$(mktemp -d "$t3_parent/.contender-XXXXXX") || return 1
  mkdir "$t3_contender/$t3_name" || return 1
  printf '%s\\n' "$$" > "$t3_contender/$t3_name/$$" || return 1
  t3_waited=0
  # Renaming a nonempty directory publishes its owner atomically. Reapers remove
  # only a dead PID's own member; rmdir cannot remove a new owner's nonempty claim.
  while ! mv "$t3_contender/$t3_name" "$t3_parent/" 2>/dev/null; do
    if [ ! -d "$t3_claim_dir" ]; then
      mv "$t3_contender/$t3_name" "$t3_parent/" 2>/dev/null && break
      [ -d "$t3_claim_dir" ] || return 1
    fi
    for t3_member in "$t3_claim_dir"/*; do
      [ -f "$t3_member" ] || continue
      t3_pid=\${t3_member##*/}
      case "$t3_pid" in ''|*[!0-9]*) continue ;; esac
      if ! kill -0 "$t3_pid" 2>/dev/null; then rm -f "$t3_member" || return 1; fi
    done
    if rmdir "$t3_claim_dir" 2>/dev/null; then continue; fi
    if [ "$t3_waited" -ge "$t3_limit" ]; then t3_release_lock; return 1; fi
    sleep 1 || return 1
    t3_waited=$((t3_waited + 1))
  done
  # Older SSH bootstraps use this PID file. Keep it live until promotion finishes.
  while :; do
    [ ! -d "$t3_legacy_lock" ] && [ ! -L "$t3_legacy_lock" ] || return 1
    ln "$t3_claim_dir/$$" "$t3_legacy_lock" 2>/dev/null && break
    if [ ! -f "$t3_legacy_lock" ]; then
      ln "$t3_claim_dir/$$" "$t3_legacy_lock" 2>/dev/null && break
      [ -f "$t3_legacy_lock" ] || return 1
    fi
    t3_pid=$(cat "$t3_legacy_lock" 2>/dev/null || :)
    case "$t3_pid" in
      ''|*[!0-9]*) if [ "$t3_waited" -ge 5 ]; then rm -f "$t3_legacy_lock" || return 1; continue; fi ;;
      *) if ! kill -0 "$t3_pid" 2>/dev/null; then rm -f "$t3_legacy_lock" || return 1; continue; fi ;;
    esac
    if [ "$t3_waited" -ge "$t3_limit" ]; then t3_release_lock; return 1; fi
    sleep 1 || return 1
    t3_waited=$((t3_waited + 1))
  done
  # npm uses a directory. A regular PID file here belongs to a shell publisher;
  # the shared claim serializes shell cleanup, including after a hard kill.
  if [ -f "$t3_root.lock" ] && [ ! -L "$t3_root.lock" ]; then
    t3_pid=$(cat "$t3_root.lock") || return 1
    case "$t3_pid" in
      ''|*[!0-9]*) ;;
      *) if ! kill -0 "$t3_pid" 2>/dev/null; then rm -f "$t3_root.lock" || return 1; fi ;;
    esac
  fi
  if [ ! -e "$t3_root" ] && [ -d "$t3_previous" ]; then t3_restore_runtime "$t3_previous" || return 1; fi
}

t3_runtime_ready() {
  [ -x "$1/t3" ] && [ -f "$1/.install-complete" ] && [ "$(cat "$1/.install-complete" 2>/dev/null)" = "$2" ] &&
    T3CODE_VERIFY_INSTALL=1 "$1/t3" --version >/dev/null
}

t3_promote_runtime() {
  t3_reused=0
  t3_had_root=0
  if [ -e "$t3_root" ]; then t3_had_root=1; fi
  # Moving a source named for the version into its parent makes mv fail on a
  # populated destination, even when an older npm launcher races outside the claim.
  t3_staged="$t3_contender/$t3_version"
  mv "$1" "$t3_staged" || return 1
  if mv "$t3_staged" "$t3_parent/" 2>/dev/null; then return 0; fi
  if t3_runtime_ready "$t3_root" "$t3_version"; then t3_reused=1; return 0; fi
  [ "$t3_had_root" = 1 ] || return 1
  # Older npm launchers use mkdir on <version>.lock before displacing a runtime.
  # Link into the parent by basename so a peer's directory cannot become the target.
  t3_npm_claim="$t3_contender/$t3_version.lock"
  ln "$t3_claim_dir/$$" "$t3_npm_claim" || return 1
  while ! ln "$t3_npm_claim" "$t3_parent/" 2>/dev/null; do
    if [ ! -d "$t3_root.lock" ]; then
      ln "$t3_npm_claim" "$t3_parent/" 2>/dev/null && break
      [ -d "$t3_root.lock" ] || return 1
    fi
    if [ "$t3_waited" -ge "\${2:-$t3_limit}" ]; then
      printf 'another t3 is installing %s. If none is running, delete %s.lock and try again.\\n' "$t3_version" "$t3_root" >&2
      return 1
    fi
    sleep 1 || return 1
    t3_waited=$((t3_waited + 1))
  done
  if t3_runtime_ready "$t3_root" "$t3_version"; then t3_reused=1; return 0; fi
  [ -e "$t3_root" ] || return 1
  t3_backup="$t3_previous"
  # Another interrupted promotion can leave both copies. Keep the earlier
  # recoverable one until the new, verified tree is on its canonical path.
  if [ -e "$t3_previous" ]; then t3_backup="$1.previous"; fi
  [ ! -e "$t3_backup" ] && [ ! -L "$t3_backup" ] || return 1
  t3_displaced="$t3_backup"
  mv "$t3_root" "$t3_displaced" || return 1
  if ! mv "$t3_staged" "$t3_parent/"; then
    t3_runtime_ready "$t3_root" "$t3_version" || return 1
    t3_reused=1
  fi
}`;
