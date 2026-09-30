#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'USAGE'
  ./start.sh                 set up what is missing, build the server, run the console
  ./start.sh stop            stop Elasticsearch; every database is kept
  ./start.sh backup [name]   snapshot every database into the backups volume
  ./start.sh restore [name]  list snapshots, or put one back in place of the data
  ./start.sh uninstall       remove what this script created, one question each
USAGE
}

VERB=
case "${1:-}" in
  ''|up) ;;
  stop|backup|restore|uninstall) VERB=$1; shift ;;
  -h|--help|help) usage; exit 0 ;;
  *) usage; exit 64 ;;
esac

cd "$(dirname "$0")"
step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
ask()  {
  local a=$2
  if [ -t 0 ]; then read -r -p "  $1 [$([ "$2" = y ] && echo Y/n || echo y/N)] " a; a=${a:-$2}; fi
  case "$a" in y|Y|yes|YES) ;; *) return 1 ;; esac
}

if [ -f .env ]; then
  grep -Evq '^[A-Z_][A-Z0-9_]*=|^#|^$' .env && die ".env has a line that is not KEY=value; fix it and run again."
  while IFS='=' read -r k v || [ -n "$k" ]; do
    case "$k" in ''|'#'*) continue ;; esac
    [ -v "$k" ] || export "$k=$v"
  done < .env
fi
record()   {
  local tmp; tmp=$(mktemp .env.XXXXXX)
  { [ ! -f .env ] || sed "/^$1=/d" .env; printf '%s=%s\n' "$1" "$2"; } > "$tmp" && mv -f "$tmp" .env
}
recorded() { grep -q "^$1=" .env 2>/dev/null; }

ES_VERSION=${ES_VERSION:-8.18.0}
ES_IMAGE="docker.elastic.co/elasticsearch/elasticsearch:$ES_VERSION"
ES_NAME=${ES_NAME:-laelaps-es}
: "${PORT:=8080}" "${ES_USER:=elastic}" "${ES_PASSWORD:=}" "${ES_URL:=http://127.0.0.1:${ES_PORT:-9200}}"
export PORT ES_USER ES_PASSWORD ES_URL
case "$ES_URL" in
  http://127.0.0.1:*|http://localhost:*) LOCAL=1; ES_PORT=${ES_URL##*:}; ES_PORT=${ES_PORT%%/*} ;;
  *) LOCAL=0 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=x86_64 ;; aarch64|arm64) ARCH=aarch64 ;;
  *) die "Unsupported architecture: $(uname -m)" ;;
esac
SWIFT_HOME=${XDG_DATA_HOME:-$HOME/.local/share}/laelaps

rt() { "$CONTAINER_RUNTIME" "$@"; }
ensure_runtime() {
  local found=() c
  for c in docker podman; do have "$c" && found+=("$c"); done
  [ ${#found[@]} -gt 0 ] || die "No container runtime found. Install Docker or Podman."
  if [ -z "${CONTAINER_RUNTIME:-}" ] || ! have "$CONTAINER_RUNTIME"; then
    if [ ${#found[@]} -eq 1 ]; then CONTAINER_RUNTIME=${found[0]}
    elif [ -t 0 ]; then
      step "Which should run Elasticsearch?"
      select CONTAINER_RUNTIME in "${found[@]}"; do [ -n "$CONTAINER_RUNTIME" ] && break; done
    else die "Both ${found[*]} are installed; set CONTAINER_RUNTIME=<one> in .env or the environment."; fi
    [ -n "$VERB" ] || record CONTAINER_RUNTIME "$CONTAINER_RUNTIME"
  fi
  rt info >/dev/null 2>&1 || die "$CONTAINER_RUNTIME is installed but not running (or not usable by this user)."
}
exists()  { rt inspect --type container "$ES_NAME" >/dev/null 2>&1; }
running() { [ "$(rt inspect --type container -f '{{.State.Running}}' "$ES_NAME" 2>/dev/null)" = true ]; }
owned()   {
  rt inspect --type container -f '{{index .Config.Labels "laelaps.owner"}} {{range .Mounts}}{{.Name}} {{end}}' "$ES_NAME" 2>/dev/null \
    | grep -qE "start\.sh|(^| )$ES_NAME-data( |$)"
}

es() {
  local m=$1 p=$2 q=${ES_PASSWORD//\\/\\\\}; shift 2; q=${q//\"/\\\"}
  curl -sS --config <(printf 'user = "%s:%s"\n' "$ES_USER" "$q") -X "$m" -H 'Content-Type: application/json' "$@" "$ES_URL/$p"
}
must() { local out; out=$("$@") || die "$out"; }
es_wait() {
  printf '  waiting for Elasticsearch at %s ' "$ES_URL"
  local code=000
  for _ in $(seq 1 120); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$ES_URL/" || true)
    case "$code" in 200|401) break ;; esac
    printf .; sleep 1
  done
  echo
  case "$code" in 200|401) ;; *)
    [ "$LOCAL" = 0 ] || rt logs --tail 40 "$ES_NAME" 2>&1 | sed 's/^/  | /'
    die "Elasticsearch did not answer within two minutes." ;;
  esac
  if [ "$(es GET '' -o /dev/null -w '%{http_code}')" = 401 ]; then
    [ "$LOCAL" = 1 ] || die "$ES_URL refuses the credentials in .env; fix ES_USER and ES_PASSWORD there."
    if [ -n "$ES_PASSWORD" ]; then step "Elasticsearch is running, but it rejects the password in .env."
    else step "Elasticsearch is running, but .env has no password for it."; fi
    note "This happens when .env was lost or replaced, for example by a fresh unzip next to an existing container."
    note "Its data can only be read with a password, so the choice is:"
    note "  1) Reset the password and keep every project and database"
    note "  2) Delete every project and database and start empty"
    local choice=1
    [ ! -t 0 ] || read -r -p "  Which? [1] " choice
    case "${choice:-1}" in
      1) ES_PASSWORD=$(rt exec "$ES_NAME" bin/elasticsearch-reset-password -u "$ES_USER" -s -b | tr -d '\r\n') || die "The reset failed; its message is above."
         record ES_PASSWORD "$ES_PASSWORD"
         [ "$(es GET '' -o /dev/null -w '%{http_code}')" = 200 ] || die "The new password was refused; the container's log may say why."
         note "password reset and recorded in .env; every database kept" ;;
      2) ask "Delete every project and database in volume '$ES_NAME-data'? This cannot be undone." n || die "Left as it was."
         step "Deleting the container and its data"
         remove_container; rt volume rm "$ES_NAME-data" >/dev/null
         return ;;
      *) die "Not an option. Nothing was changed." ;;
    esac
  fi
  note "Elasticsearch is up"
}
remove_container() {
  rt rm -f "$ES_NAME" >/dev/null

  for _ in $(seq 1 20); do exists || break; sleep 0.5; done
}
ensure_es() {
  if [ "$LOCAL" = 0 ]; then step "Elasticsearch: $ES_URL (not managed by this script)"; es_wait; return; fi
  ensure_runtime
  if exists && ! owned; then
    die "A container named '$ES_NAME' exists that this script did not create; it is left alone. Run with ES_NAME=<another name> to work beside it."
  fi

  if [ "$(cat /proc/sys/vm/max_map_count 2>/dev/null || echo 0)" -lt 262144 ]; then
    step "Raising vm.max_map_count for Elasticsearch (sudo; not persisted, redone when needed)"
    sudo sysctl -w vm.max_map_count=262144
  fi

  local args=(--name "$ES_NAME" --publish "127.0.0.1:$ES_PORT:9200" --label laelaps.owner=start.sh
    --env discovery.type=single-node --env cluster.name=laelaps
    --env xpack.security.enabled=true --env xpack.security.http.ssl.enabled=false
    --env ES_JAVA_OPTS="-Xms1g -Xmx1g" --env path.repo=/usr/share/elasticsearch/backups
    --volume "$ES_NAME-data:/usr/share/elasticsearch/data"
    --volume "$ES_NAME-backups:/usr/share/elasticsearch/backups") config
  config=$(printf '%s\n' "${args[@]}" | sha256sum | cut -c1-12)
  if exists; then
    running || { step "Starting Elasticsearch"; rt start "$ES_NAME" >/dev/null; }
    es_wait
  fi
  if exists; then
    local have; have=$(rt inspect --type container -f '{{.Config.Image}}' "$ES_NAME"); have=${have##*:}
    if [ "$have" != "$ES_VERSION" ]; then
      step "Elasticsearch $have → $ES_VERSION upgrades the data in place, which cannot be undone."
      ask "Take a backup first?" y && snapshot
      ask "Upgrade now?" n || die "Left as it was. Run with ES_VERSION=$have to keep the current version."
    elif [ "$(rt inspect --type container -f '{{index .Config.Labels "laelaps.config"}}' "$ES_NAME")" = "$config" ]; then
      return
    else
      note "the container's settings are out of date; recreating it (every database is in the volume, which stays)"
    fi
    remove_container
  else
    curl -s -o /dev/null "$ES_URL/" && die "Something already answers at $ES_URL and it is not the console's container. Edit ES_URL in .env: another loopback port gets a container of its own; another host is used as it is."

    [ -n "$ES_PASSWORD" ] || { ES_PASSWORD=$(head -c 24 /dev/urandom | base64 | tr -d '/+=\n'); record ES_PASSWORD "$ES_PASSWORD"; }
  fi
  step "Creating Elasticsearch $ES_VERSION in $CONTAINER_RUNTIME (pulls the image on first run)"
  if ! rt volume inspect "$ES_NAME-backups" >/dev/null 2>&1; then

    rt volume create "$ES_NAME-backups" >/dev/null
    rt run --rm --user 0 --entrypoint chown --volume "$ES_NAME-backups:/b" "$ES_IMAGE" 1000:0 /b
  fi
  local pw; pw=$(mktemp); printf 'ELASTIC_PASSWORD=%s\n' "$ES_PASSWORD" > "$pw"
  rt run --detach --env-file "$pw" --label "laelaps.config=$config" "${args[@]}" "$ES_IMAGE" >/dev/null
  rm -f "$pw"
  es_wait
}
snapshot() {
  local name=${1:-$(date +%Y%m%d-%H%M%S)}
  step "Snapshot '$name' into volume $ES_NAME-backups"
  must es PUT _snapshot/local --fail-with-body --data '{"type":"fs","settings":{"location":"/usr/share/elasticsearch/backups"}}'
  must es PUT "_snapshot/local/$name?wait_for_completion=true" --fail-with-body --data '{"indices":"ad-*,app-*","include_global_state":false}'
  note "done. To copy every snapshot off this machine (they share files, so the whole folder):"
  note "  $CONTAINER_RUNTIME cp $ES_NAME:/usr/share/elasticsearch/backups <folder>"
}
restore() {
  [ "$LOCAL" = 1 ] || die "restore works on the console's container; $ES_URL has a snapshot setup of its own."
  ensure_es
  if [ -z "${1:-}" ]; then es GET '_cat/snapshots/local?v&h=id,end_time,status&s=end_time' -f 2>/dev/null || note "no snapshots yet; ./start.sh backup takes one"; return; fi
  step "Restoring '$1' replaces every project and database the console has now."
  ask "Take a backup of the current data first?" y && snapshot
  ask "Replace the current data with '$1'?" n || die "Left as it was."

  must es DELETE 'ad-nodes,ad-edges,ad-assertions,ad-databases,app-projects,app-state,app-library?ignore_unavailable=true' --fail-with-body
  must es POST "_snapshot/local/$1/_restore?wait_for_completion=true" --fail-with-body --data '{"indices":"ad-*,app-*","include_global_state":false}'
  note "restored. Start the console again if it was running."
}

flavour() {
  case "$(. /etc/os-release; echo "$ID-${VERSION_ID:-}")" in
    ubuntu-22.04|ubuntu-24.04|ubuntu-26.04|debian-12|debian-13) (. /etc/os-release; echo "$ID$VERSION_ID") ;;
    *)

       if apt-cache show libxml2-16 >/dev/null 2>&1; then echo ubuntu26.04
       elif [ "$(printf '2.39\n%s\n' "$(getconf GNU_LIBC_VERSION | cut -d' ' -f2)" | sort -V | head -1)" = 2.39 ]; then echo ubuntu24.04
       else echo ubuntu22.04; fi ;;
  esac
}
ensure_swift() {
  if ! have swift && have dnf; then
    step "Installing Swift, the distribution's own package (sudo dnf install swift-lang)"
    sudo dnf install -y swift-lang || die "dnf could not install swift-lang. On RHEL it comes from EPEL; enable that and run again."
  elif ! have swift && have apt-get; then
    local v f prefix; v=$(cat .swift-version); f=$(flavour); prefix=$SWIFT_HOME/swift-$v-$f
    if [ ! -x "$prefix/usr/bin/swift" ]; then
      step "Installing the system packages Swift needs (sudo apt-get)"

      sudo apt-get install -y binutils git gnupg2 g++ libc6-dev libcurl4-openssl-dev libedit2 libncurses-dev \
        libsqlite3-0 libxml2-dev libz3-dev pkg-config tzdata unzip zip zlib1g-dev \
        $(apt-cache show binutils-gold >/dev/null 2>&1 && echo binutils-gold)
      local a=; [ "$ARCH" = x86_64 ] || a=-$ARCH
      local url="https://download.swift.org/swift-$v-release/${f//./}$a/swift-$v-RELEASE/swift-$v-RELEASE-$f$a.tar.gz"
      local tgz=$SWIFT_HOME/swift.tar.gz keys=$SWIFT_HOME/swift-keys.gpg
      mkdir -p "$SWIFT_HOME"

      step "Fetching swift.org's signing keys"
      curl -fsSL --compressed -o "$keys.asc" https://www.swift.org/keys/all-keys.asc

      if grep -q 'BEGIN PGP PUBLIC KEY BLOCK' "$keys.asc"; then gpg --dearmor < "$keys.asc" > "$keys"; else cp "$keys.asc" "$keys"; fi
      if [ -s "$tgz" ]; then step "Using the already downloaded $tgz"
      else step "Downloading Swift $v for $f from swift.org (about 1 GB)"; curl -fL --progress-bar -o "$tgz" "$url"; fi
      curl -fsSL -o "$tgz.sig" "$url.sig"
      gpgv --keyring "$keys" "$tgz.sig" "$tgz" 2>/dev/null \
        || { rm -f "$tgz"; die "The toolchain does not verify against swift.org's keys (the key file arrived as: $(file -b "$keys" | cut -c1-70)). Nothing unpacked; run again to download afresh."; }
      step "Unpacking the build tools into $prefix (the debugger, editor services and docc are left out)"
      rm -rf "$prefix.part" && mkdir -p "$prefix.part"
      tar -xzf "$tgz" -C "$prefix.part" --strip-components=1 \
        --exclude='*/lldb*' --exclude='*/liblldb*' --exclude='*/python3*' --exclude='*/sourcekit-lsp' \
        --exclude='*/libsourcekitdInProc.so' --exclude='*/docc' --exclude='*/swift-format' --exclude='*/share/doc' --exclude='*/share/man'
      mv "$prefix.part" "$prefix" && rm -f "$tgz" "$tgz.sig" "$keys.asc"
    fi
    export PATH=$prefix/usr/bin:$PATH
  elif ! have swift; then
    die "Swift is missing, and there is no dnf or apt-get to install it with. See https://www.swift.org/install/linux/"
  fi
  step "Swift: $(swift --version 2>&1 | head -1)"
}

uninstall() {
  [ -t 0 ] || die "uninstall needs a terminal: it asks before removing anything."
  step "Uninstall: nothing goes without a yes"
  if [ "$LOCAL" = 1 ]; then
    ensure_runtime
    if exists && owned && ask "Remove the Elasticsearch container '$ES_NAME'? (stops it; its data is the volume, asked next)" n; then
      rt rm -f "$ES_NAME" >/dev/null
    fi
    if ! exists; then
      local v
      for v in "$ES_NAME-data:every project and database, cannot be undone" "$ES_NAME-backups:every snapshot taken with ./start.sh backup"; do
        rt volume inspect "${v%%:*}" >/dev/null 2>&1 || continue
        ask "Delete volume ${v%%:*}? (${v#*:})" n && rt volume rm "${v%%:*}" >/dev/null
      done
    else
      note "the container stays, so its volumes stay"
    fi
  fi
  [ ! -d "$SWIFT_HOME" ] || ! ask "Delete the Swift toolchain this script unpacked under $SWIFT_HOME?" n || rm -rf "$SWIFT_HOME"
  [ ! -d .build ] || ! ask "Delete .build (the server build)?" n || rm -rf .build
  [ ! -f .env ] || ! ask "Delete .env (the Elasticsearch password; a kept data volume needs a password reset next time)?" n || rm -f .env
  note "done"
}

case "$VERB" in
  stop)
    [ "$LOCAL" = 1 ] || die "$ES_URL is not managed by this script."
    ensure_runtime
    if exists && owned && running; then rt stop "$ES_NAME" >/dev/null; note "Elasticsearch stopped; every database is kept."; else note "Elasticsearch is not running."; fi ;;
  backup)    [ "$LOCAL" = 1 ] || die "backup snapshots the console's container; $ES_URL has a snapshot setup of its own."
             ensure_es; snapshot "$@" ;;
  restore)   restore "$@" ;;
  uninstall) uninstall ;;
  *)
    recorded PORT || record PORT 8080; recorded ES_URL || record ES_URL "$ES_URL"
    ensure_es; ensure_swift
    step "Building the server (release; incremental after the first time)"
    swift build -c release
    step "Console: http://127.0.0.1:$PORT   (Ctrl-C stops it; Elasticsearch keeps running)"
    exec .build/release/App ;;
esac
