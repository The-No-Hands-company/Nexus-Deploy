#!/usr/bin/env bash
#
# Nexus Deploy sandbox setup.
#
# Creates the rootless Docker daemon that runs and builds every member's app, on
# its own user, its own size-capped filesystem and behind its own egress filter,
# so a member's code never shares a daemon, a disk or a network path with the
# rest of the node.
#
#   sudo bash sandbox/setup.sh --deploy-user <who runs Nexus Deploy> [options]
#   bash sandbox/setup.sh --print --deploy-user <name> [options]   # no root, changes nothing
#
# Idempotent: running it again repairs and re-applies, and never shrinks or
# reformats an existing storage image.
#
# Options
#   --deploy-user NAME   account that runs Nexus Deploy; gets access to the socket (required)
#   --user NAME          sandbox account to create               (default: nexus-deploy)
#   --size-gb N          storage image size, reserved up front    (default: 12)
#   --image PATH         storage image file    (default: /var/lib/nexus-deploy-sandbox/storage.img)
#   --mount PATH         where it is mounted   (default: /var/lib/nexus-deploy-sandbox/storage)
#   --min-free-percent N refuse if the image would leave less than N% free on its disk (default: 15)
#   --force              skip the free-space refusal (the operator has decided)
#   --print              print every file this would write, then exit; needs no root
#
set -euo pipefail

SANDBOX_USER="nexus-deploy"
DEPLOY_USER=""
SIZE_GB=12
IMAGE="/var/lib/nexus-deploy-sandbox/storage.img"
MOUNT="/var/lib/nexus-deploy-sandbox/storage"
MIN_FREE_PERCENT=15
FORCE=0
PRINT=0
SOCKET_DIR="/run/nexus-deploy-sandbox"
SOCKET="$SOCKET_DIR/docker.sock"
LOG_MAX_SIZE="10m"
LOG_MAX_FILE="2"

usage() { sed -n '3,25p' "$0" | sed 's/^# \{0,1\}//'; }
die() { printf 'sandbox-setup: %s\n' "$*" >&2; exit 1; }
say() { printf 'sandbox-setup: %s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --deploy-user) DEPLOY_USER="${2:?--deploy-user needs a name}"; shift 2 ;;
    --user) SANDBOX_USER="${2:?--user needs a name}"; shift 2 ;;
    --size-gb) SIZE_GB="${2:?--size-gb needs a number}"; shift 2 ;;
    --image) IMAGE="${2:?--image needs a path}"; shift 2 ;;
    --mount) MOUNT="${2:?--mount needs a path}"; shift 2 ;;
    --min-free-percent) MIN_FREE_PERCENT="${2:?--min-free-percent needs a number}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --print) PRINT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

[ -n "$DEPLOY_USER" ] || die "--deploy-user is required"
[[ "$SIZE_GB" =~ ^[0-9]+$ ]] && [ "$SIZE_GB" -ge 4 ] || die "--size-gb must be a whole number of at least 4"
[[ "$MIN_FREE_PERCENT" =~ ^[0-9]+$ ]] || die "--min-free-percent must be a whole number"
[[ "$SANDBOX_USER" =~ ^[a-z_][a-z0-9_-]{0,30}$ ]] || die "--user is not a valid account name"
[[ "$DEPLOY_USER" =~ ^[a-z_][a-z0-9_-]{0,30}$ ]] || die "--deploy-user is not a valid account name"
[ "$SANDBOX_USER" != "$DEPLOY_USER" ] || die "the sandbox account must differ from the account that runs Deploy"
[[ "$IMAGE" = /* && "$MOUNT" = /* ]] || die "--image and --mount must be absolute paths"

# ── The files this writes ─────────────────────────────────────────────────────
# Each is a function so --print and the real run share one source of truth, and
# tests/sandbox-setup.test.ts can read exactly what would be installed.

# DNS servers the egress filter must let the sandbox reach: slirp4netns forwards
# a container's lookups to whatever /etc/resolv.conf names, from the sandbox
# account, so a filter that blocked them would break every build.
resolvers() {
  { cat /etc/resolv.conf /run/systemd/resolve/resolv.conf 2>/dev/null || true; } \
    | awk '$1 == "nameserver" && $2 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ { print $2 }' | sort -u
}

render_daemon_json() {
  cat <<EOF
{
  "log-driver": "local",
  "log-opts": { "max-size": "$LOG_MAX_SIZE", "max-file": "$LOG_MAX_FILE", "compress": "false" }
}
EOF
}

render_unit() {
  cat <<EOF
[Unit]
Description=Nexus Deploy sandbox Docker daemon (rootless)
After=network-online.target
Wants=network-online.target
RequiresMountsFor=$MOUNT

[Service]
Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_NET=slirp4netns
# Containers must not reach the host's own loopback services (Auth, Cloud, the databases).
Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=true
Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_STATE_DIR=%t/nexus-sandbox/rootlesskit
ExecStartPre=/usr/bin/mkdir -p %t/nexus-sandbox $MOUNT/docker
ExecStart=/usr/bin/dockerd-rootless.sh --config-file=%h/.config/docker/daemon.json --data-root=$MOUNT/docker --exec-root=%t/nexus-sandbox --host=unix://$SOCKET --pidfile=%t/nexus-sandbox/docker.pid
Delegate=yes
Type=simple
KillMode=mixed
Restart=on-failure
RestartSec=5s
LimitNOFILE=infinity
TasksMax=infinity

[Install]
WantedBy=default.target
EOF
}

# The socket lives outside the sandbox account's runtime directory (which is
# private to it) so the Deploy account can reach it, and only that account can.
render_tmpfiles() {
  cat <<EOF
d $SOCKET_DIR 0750 $SANDBOX_USER $SANDBOX_USER -
a+ $SOCKET_DIR - - - - user:$DEPLOY_USER:r-x
a+ $SOCKET_DIR - - - - default:user:$DEPLOY_USER:rw-
EOF
}

# nftables: the sandbox account may not open connections to this machine or to
# private networks. Without it a member's container reaches every service the host
# binds to a LAN address (a rootless daemon only blocks the host's loopback).
# DNS to the machine's resolvers is let through first.
render_nft() {
  local uid="$1" r
  cat <<EOF
table inet nexus_deploy_sandbox {
  chain output {
    type filter hook output priority 0; policy accept;
EOF
  while IFS= read -r r; do
    [ -n "$r" ] || continue
    printf '    meta skuid %s ip daddr %s udp dport 53 accept\n' "$uid" "$r"
    printf '    meta skuid %s ip daddr %s tcp dport 53 accept\n' "$uid" "$r"
  done <<<"$(resolvers)"
  cat <<EOF
    meta skuid $uid ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4 } drop
    meta skuid $uid ip6 daddr { ::1, fc00::/7, fe80::/10, ff00::/8 } drop
  }
}
EOF
}

render_nft_unit() {
  cat <<EOF
[Unit]
Description=Nexus Deploy sandbox egress filter
After=network-pre.target
Before=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c '/usr/sbin/nft delete table inet nexus_deploy_sandbox 2>/dev/null; /usr/sbin/nft -f /etc/nexus-deploy-sandbox/egress.nft'
ExecStop=/bin/sh -c '/usr/sbin/nft delete table inet nexus_deploy_sandbox 2>/dev/null || true'

[Install]
WantedBy=multi-user.target
EOF
}

render_fstab_line() {
  printf '%s %s ext4 loop,nodev,nosuid,noatime 0 0\n' "$IMAGE" "$MOUNT"
}

render_env() {
  cat <<EOF
# Add to the environment Nexus Deploy starts with:
SANDBOX_DOCKER_HOST=unix://$SOCKET
SANDBOX_STORAGE_PATH=$MOUNT
SANDBOX_STORAGE_SIZE_GB=$SIZE_GB
EOF
}

UID_FOR_PRINT="$(id -u "$SANDBOX_USER" 2>/dev/null || echo 65000)"

if [ "$PRINT" -eq 1 ]; then
  for f in \
    "daemon.json:render_daemon_json" \
    "nexus-sandbox-docker.service:render_unit" \
    "tmpfiles:render_tmpfiles" \
    "egress.nft:render_nft $UID_FOR_PRINT" \
    "egress.service:render_nft_unit" \
    "fstab:render_fstab_line" \
    "env:render_env"; do
    printf '### %s\n' "${f%%:*}"
    ${f#*:}
  done
  exit 0
fi

# ── From here on it changes the machine ──────────────────────────────────────
[ "$(id -u)" -eq 0 ] || die "run as root: sudo bash sandbox/setup.sh --deploy-user $DEPLOY_USER"
[ "$(uname -s)" = "Linux" ] || die "Linux only"
id "$DEPLOY_USER" >/dev/null 2>&1 || die "no such account: $DEPLOY_USER"

for tool in newuidmap newgidmap rootlesskit dockerd-rootless.sh slirp4netns mkfs.ext4 losetup nft setfacl systemctl loginctl runuser; do
  command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
done

# 1. The account, with subordinate uid/gid ranges.
if id "$SANDBOX_USER" >/dev/null 2>&1; then
  say "account $SANDBOX_USER exists"
else
  say "creating account $SANDBOX_USER"
  useradd --create-home --shell /usr/sbin/nologin "$SANDBOX_USER"
fi
SANDBOX_UID="$(id -u "$SANDBOX_USER")"
if ! grep -q "^$SANDBOX_USER:" /etc/subuid || ! grep -q "^$SANDBOX_USER:" /etc/subgid; then
  # First free block above every existing range.
  start="$(cat /etc/subuid /etc/subgid | awk -F: 'BEGIN{m=99999} {e=$2+$3; if (e>m) m=e} END{print m+1}')"
  say "granting $SANDBOX_USER subordinate ids $start-$((start + 65535))"
  usermod --add-subuids "$start-$((start + 65535))" --add-subgids "$start-$((start + 65535))" "$SANDBOX_USER"
fi
loginctl enable-linger "$SANDBOX_USER"

# 2. The storage image: a fixed size, reserved now, so the sandbox can never
#    grow past it and the rest of the node can never be starved by it.
mkdir -p "$(dirname "$IMAGE")" "$MOUNT"
if [ -e "$IMAGE" ]; then
  say "storage image $IMAGE exists; leaving it alone"
else
  disk_dir="$(dirname "$IMAGE")"
  read -r total avail < <(df -B1 --output=size,avail "$disk_dir" | tail -1)
  want=$((SIZE_GB * 1024 * 1024 * 1024))
  left=$((avail - want))
  if [ "$left" -lt 0 ]; then
    die "$disk_dir has only $((avail / 1073741824)) GB free; the image needs $SIZE_GB GB"
  fi
  left_pct=$((left * 100 / total))
  if [ "$left_pct" -lt "$MIN_FREE_PERCENT" ] && [ "$FORCE" -ne 1 ]; then
    die "a ${SIZE_GB} GB image would leave ${left_pct}% free on $disk_dir (minimum ${MIN_FREE_PERCENT}%). Choose a smaller --size-gb, a different --image, or pass --force."
  fi
  say "reserving ${SIZE_GB} GB at $IMAGE (leaves ${left_pct}% free)"
  : > "$IMAGE"
  chattr +C "$IMAGE" 2>/dev/null || true   # no copy-on-write for a loop image on btrfs
  fallocate -l "${SIZE_GB}G" "$IMAGE"
  chmod 600 "$IMAGE"
  mkfs.ext4 -q -F -L nexus-sandbox "$IMAGE"
fi
fstab_line="$(render_fstab_line)"
grep -qsF "$fstab_line" /etc/fstab || { say "adding the image to /etc/fstab"; printf '%s\n' "$fstab_line" >> /etc/fstab; }
systemctl daemon-reload
mountpoint -q "$MOUNT" || mount "$MOUNT"
chown "$SANDBOX_USER:$SANDBOX_USER" "$MOUNT"
chmod 700 "$MOUNT"

# 3. The socket directory, shared with the Deploy account only.
render_tmpfiles > /etc/tmpfiles.d/nexus-deploy-sandbox.conf
systemd-tmpfiles --create /etc/tmpfiles.d/nexus-deploy-sandbox.conf

# 4. Egress filter.
install -d -m 755 /etc/nexus-deploy-sandbox
render_nft "$SANDBOX_UID" > /etc/nexus-deploy-sandbox/egress.nft
nft -c -f /etc/nexus-deploy-sandbox/egress.nft || die "the generated egress rules do not parse"
render_nft_unit > /etc/systemd/system/nexus-deploy-sandbox-egress.service
systemctl daemon-reload
systemctl enable nexus-deploy-sandbox-egress.service >/dev/null 2>&1
systemctl restart nexus-deploy-sandbox-egress.service

# 5. The daemon, as a user service of the sandbox account.
home="$(getent passwd "$SANDBOX_USER" | cut -d: -f6)"
install -d -o "$SANDBOX_USER" -g "$SANDBOX_USER" -m 700 "$home/.config" "$home/.config/docker" "$home/.config/systemd" "$home/.config/systemd/user"
render_daemon_json | install -o "$SANDBOX_USER" -g "$SANDBOX_USER" -m 600 /dev/stdin "$home/.config/docker/daemon.json"
render_unit | install -o "$SANDBOX_USER" -g "$SANDBOX_USER" -m 600 /dev/stdin "$home/.config/systemd/user/nexus-sandbox-docker.service"
systemctl start "user@$SANDBOX_UID.service"
user_env=(env "XDG_RUNTIME_DIR=/run/user/$SANDBOX_UID" "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$SANDBOX_UID/bus")
runuser -u "$SANDBOX_USER" -- "${user_env[@]}" systemctl --user daemon-reload
runuser -u "$SANDBOX_USER" -- "${user_env[@]}" systemctl --user enable nexus-sandbox-docker.service >/dev/null 2>&1
runuser -u "$SANDBOX_USER" -- "${user_env[@]}" systemctl --user restart nexus-sandbox-docker.service

say "waiting for the daemon"
for _ in $(seq 1 40); do [ -S "$SOCKET" ] && break; sleep 0.5; done
[ -S "$SOCKET" ] || die "the daemon did not come up; see: sudo -u $SANDBOX_USER XDG_RUNTIME_DIR=/run/user/$SANDBOX_UID journalctl --user -u nexus-sandbox-docker"
chmod 660 "$SOCKET" 2>/dev/null || true

say "done."
echo
render_env
echo
say "next: as $DEPLOY_USER, run the checks:  cd apps/Nexus-Deploy && npm run doctor"
