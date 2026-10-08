# slackteam

A Slack-driven agent team: you are the PM, the **EM** agent turns your goals into OKRs/PRDs (`.md` + `.json` in an Obsidian-style git vault), and two **SWE** agents plan, get EM review, implement in git worktrees, test and open PRs. Agents can SSH to your hosts (e.g. the Oracle box); risky commands need your Slack approval.

## Setup
1. **Slack app**: create from `slack-manifest.yaml` (api.slack.com/apps → From manifest). Install it; copy the bot token (`xoxb-`) and create an app-level token (`xapp-`, scope `connections:write`).
2. **GitHub**: create an empty `product-vault` repo; make a fine-grained token with contents + pull-requests on it and on the repos in `config/repos.yaml`.
3. **Claude**: run `claude setup-token` once; the token goes in `.env` as `CLAUDE_CODE_OAUTH_TOKEN` (long-lived, so agents never ask you to log in).
4. `cp .env.example .env` and fill it in. Edit `config/teams.yaml` and `hosts.yaml` (optionally add `config/repos.yaml` for per-repo `test_cmd`/teams; otherwise paste GitHub links in Slack) (SSH aliases must exist in `~/.ssh/config`, key mounted via compose).
5. `docker compose build`, then run the one-time bootstrap inside the container (it has `.env`, a writable `/data` and git auth). It scaffolds the vault and creates `#em-intake` and the `#team-*` channels with a pinned context template (fill those pins in):
   `docker compose run --rm orchestrator sh -c "gh auth setup-git && node dist/scripts/init-vault.js && node dist/scripts/bootstrap-slack.js"`
6. `docker compose up -d`

## Using it
- **Adding repos**: paste a GitHub link (repo, PR, branch, or `git@` URL) in a DM, `#em-intake` or a job channel and it's added to the repos the agents can work on (default branch auto-detected, stored in sqlite so it survives restarts). An optional `config/repos.yaml` is the place for `test_cmd`/teams. Your `GH_TOKEN` must have access to the repo.
- DM the bot or post in `#em-intake` with a goal. The EM reads team context, asks questions, then opens a private `#job-NNNN-slug` channel.
- In a job channel: plain messages go to the EM; `swe-1: ...` / `swe-2: ...` go to that engineer. Reply **in the thread** of a question to answer it. Approval requests show Approve/Deny buttons.
- `@Slackteam` in a team channel talks to the EM about that team without starting a job.
- Tell the EM to close the job when merged: it marks the PRD shipped, posts a summary to the team channels, removes worktrees and archives the channel.

## Safeguards
- Only `PM_SLACK_USER_ID` (a Slack member ID like `U0123456`; startup fails if missing or malformed) can direct the agents. Agents @mention this user when they ask a question or need approval, and re-mention them every `QUESTION_REMINDER_MS` (default 30 min, max 3 times) while unanswered. Closed questions are acknowledged with a message and a reaction (the reaction needs the `reactions:write` scope: reinstall the app after updating `slack-manifest.yaml`).
- Every Bash call is classified (`src/guard/risky.ts`), including the command inside `ssh host '...'`; risky ones wait for your approval (timeout = denied).
- SWEs cannot Edit/Write until the EM approves their tech plan, and only inside their worktree. The EM has no shell and writes only through `write_okr`/`write_prd`.

## Dev
`npm test`, `npm run typecheck`, `npm run dev`.
