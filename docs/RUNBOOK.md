# Oracle deploy runbook

Host: `oracle` (Oracle Linux 10, aarch64, user `opc`). Checkout: `/opt/slackteam` (branch `master`, the repo default branch). Docker CE runs as a systemd service, enabled at boot. `opc` is not in the `docker` group, so use `sudo docker`.

## Environment file
Path: `/opt/slackteam/.env` (mode 600, owner `opc`). **The PM creates it**; it is not in git and engineers never read or print it. `docker compose up` fails if it is missing.

Variable names (copy `.env.example`, fill in values):
`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `PM_SLACK_USER_ID`, `CLAUDE_CODE_OAUTH_TOKEN`, `GH_TOKEN`, `VAULT_REPO`, `DATA_DIR`, `MAX_CONCURRENT_JOBS`, `APPROVAL_TIMEOUT_MIN`, `QUESTION_REMINDER_MS`, `JUDGE_MODEL`, `JUDGE_TIMEOUT_MS`.

## Start (PM step)
```
cd /opt/slackteam && sudo docker compose up -d
sudo docker compose logs -f --tail=100   # check
```
Compose uses `restart: unless-stopped` and json-file log rotation (10m x 3). First run also needs the one-time bootstrap in README step 5.
Note: compose mounts `${HOME}/.ssh` read-only into the container; hardening is tracked separately. Under `sudo`, `${HOME}` may resolve to `/root`; check `sudo sh -c "echo $HOME"` before starting.

## Deploy / update
```
cd /opt/slackteam
git fetch origin && git rev-parse HEAD            # note previous sha (for rollback)
sudo docker image ls slackteam-orchestrator       # note previous image id
git checkout --detach <sha>   # or: git pull --ff-only on master
sudo docker compose build
sudo docker tag slackteam-orchestrator:latest slackteam-orchestrator:<sha7>
sudo docker compose up -d
```
Check free disk first (`df -h /`, keep >= 5G). The Dockerfile is unpinned (node tag, claude-code, gh), so record sha and image id for each build. Do not run `docker system prune` without approval.

## Rollback
```
cd /opt/slackteam
git checkout --detach <previous sha>
sudo docker tag slackteam-orchestrator:<previous sha7> slackteam-orchestrator:latest   # reuse the old image
sudo docker compose up -d --no-build
```
If the old tag is gone, rebuild with `sudo docker compose build` at that sha.

## Stop
`sudo docker compose down` (data in `/opt/slackteam/data` is kept).

## Current build
Built on the box from master `229315f`, image `slackteam-orchestrator:229315f` (arm64, id f7b6e7643eab).
