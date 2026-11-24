export const runtimePromotion = `# Runtime promotion, also embedded in the SSH bootstrap and service installer.
t3_release_lock() {
  if [ -n "$t3_claim_dir" ] && [ -f "$t3_claim_dir/$$" ]; then
    if [ "$t3_legacy_lock" -ef "$t3_claim_dir/$$" ]; then rm -f "$t3_legacy_lock" || return 1; fi
    rm -f "$t3_claim_dir/$$" || return 1
    rmdir "$t3_claim_dir" 2>/dev/null || :
  fi
  if [ -n "$t3_contender" ]; then rm -rf "$t3_contender"; fi
}

t3_acquire_lock() {
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
  if [ ! -e "$t3_root" ] && [ -d "$t3_previous" ]; then mv "$t3_previous" "$t3_root" || return 1; fi
}

t3_promote_runtime() {
  t3_staged=$1
  t3_displaced="$t3_previous"
  # Another interrupted promotion can leave both copies. Keep the earlier
  # recoverable one until the new, verified tree is on its canonical path.
  if [ -e "$t3_previous" ]; then t3_displaced="$t3_staged.previous"; fi
  if [ -e "$t3_root" ]; then
    [ ! -e "$t3_displaced" ] && [ ! -L "$t3_displaced" ] || return 1
    mv "$t3_root" "$t3_displaced" || return 1
  fi
  [ ! -e "$t3_root" ] && [ ! -L "$t3_root" ] || return 1
  if ! mv "$t3_staged" "$t3_root"; then
    if [ ! -e "$t3_root" ] && [ -d "$t3_displaced" ]; then mv "$t3_displaced" "$t3_root" || return 1; fi
    return 1
  fi
  rm -rf "$t3_displaced" "$t3_previous"
}`;
