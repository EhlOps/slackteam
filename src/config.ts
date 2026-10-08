import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const Env = z.object({
  SLACK_BOT_TOKEN: z.string().startsWith('xoxb-'),
  SLACK_APP_TOKEN: z.string().startsWith('xapp-'),
  PM_SLACK_USER_ID: z.string().min(1),
  VAULT_REPO: z.string().min(1),
  DATA_DIR: z.string().default('/data'),
  MAX_CONCURRENT_JOBS: z.coerce.number().int().positive().default(1),
  APPROVAL_TIMEOUT_MIN: z.coerce.number().positive().default(60),
  JUDGE_MODEL: z.string().default('claude-haiku-4-5'),
  JUDGE_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
});

const Teams = z.object({
  teams: z.array(z.object({ key: z.string(), channel: z.string(), description: z.string() })),
});
const Repos = z.object({
  repos: z.array(
    z.object({
      name: z.string(),
      github: z.string(),
      default_branch: z.string().default('main'),
      test_cmd: z.string().optional(),
      teams: z.array(z.string()).default([]),
    }),
  ),
});
const Hosts = z.object({
  hosts: z.array(z.object({ alias: z.string(), description: z.string().default(''), prod: z.boolean().default(false) })),
});

export type Teams = z.infer<typeof Teams>['teams'];
export type Repos = z.infer<typeof Repos>['repos'];
export type Hosts = z.infer<typeof Hosts>['hosts'];

const yamlFile = <T extends z.ZodTypeAny>(schema: T, name: string, dir: string): z.infer<T> =>
  schema.parse(parse(readFileSync(join(dir, name), 'utf8')));

/** repos.yaml is optional: repos can also be added by pasting GitHub links in Slack. */
const optionalRepos = (dir: string) => (existsSync(join(dir, 'repos.yaml')) ? yamlFile(Repos, 'repos.yaml', dir).repos : []);

export function loadConfig(configDir = join(process.cwd(), 'config')) {
  const env = Env.parse(process.env);
  return {
    env,
    teams: yamlFile(Teams, 'teams.yaml', configDir).teams,
    repos: optionalRepos(configDir),
    hosts: yamlFile(Hosts, 'hosts.yaml', configDir).hosts,
  };
}
export type Config = ReturnType<typeof loadConfig>;
