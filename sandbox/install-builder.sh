#!/usr/bin/env bash
#
# Installs Railpack (the single-binary builder Nexus Deploy uses when a
# repository has no Dockerfile) into a user-writable executable directory.
#
#   bash sandbox/install-builder.sh [--install-dir DIR]
#   bash sandbox/install-builder.sh --print [--install-dir DIR]
#
# Needs no root privileges. Verifies the SHA-256 digest of both the release
# archive and the extracted binary before moving it into place, and skips the
# download when the verified binary is already installed.
#
# Options
#   --install-dir DIR   where to place the railpack binary (default: $HOME/.local/bin)
#   --print             print the pinned version, URL, digests and target path, then exit
#
set -euo pipefail

RAILPACK_VERSION="0.43.0"
RAILPACK_ARCH="x86_64-unknown-linux-musl"
RAILPACK_TARBALL="railpack-v${RAILPACK_VERSION}-${RAILPACK_ARCH}.tar.gz"
RAILPACK_URL="https://github.com/railwayapp/railpack/releases/download/v${RAILPACK_VERSION}/${RAILPACK_TARBALL}"
RAILPACK_TARBALL_SHA256="248a8f60f36854aabed6124113631078a802de3461660855fc4de9c26065c1fb"
RAILPACK_BINARY_SHA256="3e9a8477b2c7cd0bfb46ebdb0ca5f3153329f4f01cec263dbb6ea9b4679a3af9"
RAILPACK_FRONTEND="ghcr.io/railwayapp/railpack-frontend:v${RAILPACK_VERSION}"

INSTALL_DIR="${INSTALL_DIR:-${HOME}/.local/bin}"
PRINT=0

usage() { sed -n '3,16p' "$0" | sed 's/^# \{0,1\}//'; }
die() { printf 'install-builder: %s\n' "$*" >&2; exit 1; }
say() { printf 'install-builder: %s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --install-dir) INSTALL_DIR="${2:?--install-dir needs a path}"; shift 2 ;;
    --print) PRINT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

case "$INSTALL_DIR" in
  /*) ;;
  *) die "--install-dir must be an absolute path: $INSTALL_DIR" ;;
esac

TARGET="${INSTALL_DIR}/railpack"

if [ "$PRINT" -eq 1 ]; then
  cat <<EOF
BUILDER=railpack
RAILPACK_VERSION=${RAILPACK_VERSION}
RAILPACK_URL=${RAILPACK_URL}
RAILPACK_TARBALL_SHA256=${RAILPACK_TARBALL_SHA256}
RAILPACK_BINARY_SHA256=${RAILPACK_BINARY_SHA256}
RAILPACK_FRONTEND=${RAILPACK_FRONTEND}
RAILPACK_BIN=${TARGET}
EOF
  exit 0
fi

if [ -x "$TARGET" ]; then
  CURRENT_SHA="$(sha256sum "$TARGET" | awk '{print $1}')"
  if [ "$CURRENT_SHA" = "$RAILPACK_BINARY_SHA256" ]; then
    say "railpack v${RAILPACK_VERSION} is already installed at ${TARGET}"
    exit 0
  fi
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/nexus-railpack-install.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

say "downloading railpack v${RAILPACK_VERSION} from ${RAILPACK_URL}"
curl -fsSL "$RAILPACK_URL" -o "$WORK/$RAILPACK_TARBALL"

printf '%s  %s\n' "$RAILPACK_TARBALL_SHA256" "$WORK/$RAILPACK_TARBALL" | sha256sum -c - >/dev/null \
  || die "archive SHA-256 mismatch for $RAILPACK_TARBALL"

tar -xzf "$WORK/$RAILPACK_TARBALL" -C "$WORK" railpack
[ -f "$WORK/railpack" ] || die "archive did not contain railpack binary"

printf '%s  %s\n' "$RAILPACK_BINARY_SHA256" "$WORK/railpack" | sha256sum -c - >/dev/null \
  || die "binary SHA-256 mismatch for railpack"

mkdir -p "$INSTALL_DIR"
chmod 0755 "$WORK/railpack"
mv -f "$WORK/railpack" "$TARGET"

"$TARGET" --version >/dev/null \
  || die "${TARGET} is not executable (check that ${INSTALL_DIR} is not mounted noexec)"

say "installed $("${TARGET}" --version) at ${TARGET}"
