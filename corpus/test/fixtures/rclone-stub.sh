#!/usr/bin/env bash
# Stub rclone for assemble.sh tests. STUB_MODE:
#   lsf-fail   every lsf fails (bad creds / network)
#   ok         one lane "lane-0" per kind, STUB_ROWS manifest rows each (default 1)
#   copy-fail  like ok, but copy exits 1
mode="${STUB_MODE:-ok}"; rows="${STUB_ROWS:-1}"
args=("$@"); sub=""
for a in "${args[@]}"; do case "$a" in lsf|copy|cat) sub=$a; break ;; esac; done
last="${args[${#args[@]}-1]}"
case "$sub" in
  lsf)
    [ "$mode" = lsf-fail ] && { echo "Failed to lsf: AccessDenied" >&2; exit 1; }
    case " ${args[*]} " in
      *" --dirs-only "*) echo "lane-0/" ;;
      *) echo "a.md" ;;
    esac ;;
  copy)
    [ "$mode" = copy-fail ] && { echo "ERROR : a.md: Failed to copy" >&2; exit 1; }
    echo "INFO  : a.md: Copied (new)" >&2 ;;
  cat)
    for i in $(seq 1 "$rows"); do printf 'item-%s-%s\tok\tOK\tmain\t1\t1\n' "$(basename "$(dirname "$last")")" "$i"; done ;;
esac
exit 0
