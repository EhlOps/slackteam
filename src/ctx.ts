import type { WebClient } from '@slack/web-api';
import type { Config } from './config.js';
import type { Interactions } from './slack/interactions.js';
import type { Vault } from './vault/git.js';
import type { Db, AgentName } from './workflow/db.js';
import type { Worktrees } from './workflow/worktrees.js';

export interface Runner {
  /** Queue a prompt for an agent (serialized per job+agent). Resolves when that run finishes. */
  send(jobId: number, agent: AgentName, prompt: string, channel?: string): Promise<void>;
}

export interface Ctx {
  client: WebClient;
  cfg: Config;
  db: Db;
  interactions: Interactions;
  vault: Vault;
  worktrees: Worktrees;
  runner: Runner;
  /** Channel for conversations that are not yet a job (DMs and #em-intake). */
  intakeChannel: string;
}
