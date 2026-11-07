# The Nexus Deploy sandbox

Every member's app is built and run by one **rootless Docker daemon** that belongs to a
dedicated account, lives on its own size-capped filesystem, and sits behind its own
network filter. Deploy talks to that daemon only; with `SANDBOX_DOCKER_HOST` empty it
refuses to build or run anything rather than fall back to the host's Docker.

## Set it up (once, by the operator)

```bash
cd apps/Nexus-Deploy
bash sandbox/install-builder.sh                          # installs Railpack v0.43.0 into ~/.local/bin (no root)
bash sandbox/setup.sh --print --deploy-user "$USER"      # read what it will do; changes nothing
sudo bash sandbox/setup.sh --deploy-user "$USER" --size-gb 12
```

Then put the three `SANDBOX_*` lines it prints into the environment Deploy starts with,
and run `npm run doctor`. Running the setup again repairs and re-applies it; it never
shrinks or reformats an existing storage image.

### What it costs

The only resource the sandbox takes is **disk, reserved up front**: `--size-gb` gigabytes
in one file (default `/var/lib/nexus-deploy-sandbox/storage.img`). That is the whole
point: a runaway build can fill that file and fail, but it cannot fill the disk the rest
of the node runs on. The script refuses if the image would leave less than 15% of its
disk free (`--min-free-percent`); `--force` overrides that, and only the operator should.

### What it changes

| What | Where |
|---|---|
| An account `nexus-deploy` (login disabled), with a subordinate uid/gid range and lingering | `/etc/passwd`, `/etc/subuid`, `/etc/subgid` |
| The storage image and its mount | `--image`, `--mount`, one line in `/etc/fstab` |
| A socket directory shared with the Deploy account only | `/run/nexus-deploy-sandbox/`, `/etc/tmpfiles.d/nexus-deploy-sandbox.conf` |
| The daemon, as a user service of that account | `~nexus-deploy/.config/systemd/user/nexus-sandbox-docker.service`, `~nexus-deploy/.config/docker/daemon.json` |
| The egress filter | `/etc/nexus-deploy-sandbox/egress.nft`, `nexus-deploy-sandbox-egress.service` |

### The egress filter

A rootless daemon already keeps containers off the host's own loopback. It does **not**
keep them off the host's LAN address, so a container could reach every service this
machine binds to all interfaces. The filter drops the sandbox account's connections to
loopback, private and link-local ranges, except DNS to the machine's own resolvers.
If the machine's resolvers change, run the setup again; `npm run doctor` says so.

## Check it

`npm run doctor` proves each property from inside a container: rootless, log caps,
no capabilities, its own filesystem, no route to the host's loopback or LAN, and working
DNS. It exits 1 on any failure.

## Take it out

```bash
sudo systemctl disable --now nexus-deploy-sandbox-egress.service
sudo rm -f /etc/systemd/system/nexus-deploy-sandbox-egress.service /etc/tmpfiles.d/nexus-deploy-sandbox.conf
sudo rm -rf /etc/nexus-deploy-sandbox
sudo runuser -u nexus-deploy -- env XDG_RUNTIME_DIR=/run/user/$(id -u nexus-deploy) systemctl --user disable --now nexus-sandbox-docker.service
sudo umount /var/lib/nexus-deploy-sandbox/storage
sudo sed -i '\#/var/lib/nexus-deploy-sandbox/storage #d' /etc/fstab
sudo rm -rf /var/lib/nexus-deploy-sandbox
sudo userdel -r nexus-deploy
```
