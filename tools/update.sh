#!/bin/sh
# Update a live site safely: back up its data, optionally rehearse the new
# version on a copy of that data, then deploy it.
#   tools/update.sh <site-dir> <hostname> [--rehearse <copy-hostname>] [--no-dump] [--build] [deploy options]
#  1. dump: the site's objects go to $CELLD_BACKUP_DIR (default ./backups) as
#     <hostname>-<time>.backup. A site that does not exist yet has nothing to
#     back up and is deployed as is. --no-dump skips this (dumps can be large).
#  2. rehearse (--rehearse): deploy the new version to <copy-hostname>, restore
#     the dump into it (so the new version's migrations run on real data) and
#     request its check path. The copy must be a site of its own (a hostname
#     that is not an alias of <hostname>); its data is replaced. It needs a
#     dump, so it cannot be combined with --no-dump.
#  3. deploy: tools/deploy.sh with the remaining options (check before, watch
#     after, rollback of code on a 5xx).
# The dump is deleted when the deploy succeeds and kept when it fails; the path
# is printed so `admin.sh POST '/restore?host=H&confirm=H' - < file` can put the
# data back. CELLD_COMPOSE_DIR works as for deploy.sh and admin.sh.
set -eu
usage="usage: tools/update.sh <site-dir> <hostname> [--rehearse <copy-hostname>] [--no-dump] [deploy.sh options]"
site="${1:?$usage}"
host="${2:?$usage}"
shift 2
here=$(cd "$(dirname "$0")" && pwd)
project="${CELLD_COMPOSE_DIR:-$(dirname "$here")}"
log() { echo "update: $*" >&2; }

copy= dump=1
for arg; do
	shift
	if [ -n "${want_copy:-}" ]; then copy=$arg; want_copy=; continue; fi
	case "$arg" in
	--rehearse) want_copy=1 ;;
	--no-dump) dump= ;;
	*) set -- "$@" "$arg" ;;
	esac
done
[ -z "${want_copy:-}" ] || { echo "$usage" >&2; exit 2; }
[ -z "$copy" ] || [ -n "$dump" ] || { echo "update: --rehearse needs a dump; drop --no-dump" >&2; exit 2; }
[ "$copy" != "$host" ] || { echo "update: the rehearsal copy must not be $host itself" >&2; exit 2; }

file=
if [ -n "$dump" ]; then
	dir="${CELLD_BACKUP_DIR:-backups}"
	mkdir -p "$dir"
	file="$dir/$host-$(date -u +%Y%m%dT%H%M%SZ).backup"
	umask 077
	err=$(mktemp)
	trap 'rm -f "$err"' EXIT
	if "$here/admin.sh" GET "/dump?host=$host" > "$file" 2> "$err"; then
		if ! grep -q '"type":"end"' "$file"; then
			log "the dump is incomplete (no end line): $file"; exit 1
		fi
		log "dumped $host to $file ($(wc -c < "$file") bytes)"
	elif grep -q "no site for" "$file" "$err"; then
		log "$host is not a site yet; nothing to back up"
		rm -f "$file"; file=
	else
		log "dump failed: $(head -c 300 "$err") $(head -c 300 "$file")"
		rm -f "$file"; exit 1
	fi
fi

if [ -n "$copy" ]; then
	[ -n "$file" ] || { log "$host has no data to rehearse with"; exit 1; }
	log "rehearsing on $copy"
	"$here/deploy.sh" "$site" "$copy" "$@" >/dev/null
	"$here/admin.sh" POST "/restore?host=$copy&confirm=$copy" - < "$file" >/dev/null
	# Request the site's own root on the restored data (the version's check path
	# if it has a different one is covered by the deploy check on empty data).
	code=$(docker compose --project-directory "$project" exec -T celld curl -s -o /dev/null -w '%{http_code}' -m 30 -H "Host: $copy" -H "Accept: text/html" http://127.0.0.1:8080/ || true)
	case "$code" in
	[1-4]??) log "rehearsal passed: $copy answered $code on the restored data" ;;
	*) log "rehearsal failed: $copy answered ${code:-nothing} on the restored data; $host is untouched. Backup kept: ${file:-none}"; exit 1 ;;
	esac
fi

if "$here/deploy.sh" "$site" "$host" "$@"; then
	[ -z "$file" ] || { rm -f "$file"; log "deployed; removed the backup"; }
else
	log "deploy failed. Backup kept: ${file:-none}"
	[ -z "$file" ] || log "restore with: tools/admin.sh POST '/restore?host=$host&confirm=$host' - < $file"
	exit 1
fi
