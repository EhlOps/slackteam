import type { Hosts } from '../config.js';

export interface Classification {
  risky: boolean;
  reasons: string[];
}

const PATTERNS: Array<[RegExp, string]> = [
  [/\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/, 'recursive delete'],
  [/\bsudo\b/, 'sudo'],
  [/\bsystemctl\s+(stop|restart|disable|mask|kill|reload|daemon-reload)\b/, 'systemctl service change'],
  [/\b(reboot|shutdown|poweroff|halt)\b/, 'reboot/shutdown'],
  [/\b(apt(-get)?|dnf|yum|brew|pip3?|npm)\s+(remove|purge|uninstall|autoremove)\b/, 'package removal'],
  [/\b(iptables|ip6tables|ufw|firewall-cmd|nft)\b/, 'firewall change'],
  [/\boci\s+\S+.*\b(create|delete|update|terminate|launch)\b/, 'OCI write'],
  [/\b(chmod|chown)\s+(-[a-zA-Z]*R[a-zA-Z]*)\s+\S*\s*\/(etc|usr|var|bin|sbin|lib|boot|opt)?\b/, 'recursive chmod/chown on system path'],
  [/\bgit\s+push\b.*(--force\b|--force-with-lease|\s-f\b|\s\+\S)/, 'force push'],
  [/\bgh\s+pr\s+merge\b/, 'merge PR'],
  [/\bgh\s+repo\s+(delete|archive)\b/, 'delete/archive repo'],
  [/\b(drop|truncate)\s+(table|database|schema)\b/i, 'destructive SQL'],
  [/\bmkfs\b|\bdd\s+.*\bof=\/dev\//, 'disk write'],
  [/\bcurl\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/, 'pipe to shell'],
];

const SSH = /\bssh\s+((?:-\S+\s+(?:\S+\s+)?)*)(?:\S+@)?([A-Za-z0-9._-]+)\s+(?:(['"])([\s\S]*)\3|([\s\S]+))$/;
const READONLY = /^\s*(ls|cat|head|tail|grep|egrep|df|du|free|uptime|whoami|hostname|uname|ps|top|pwd|echo|id|date|which|stat|find|journalctl|systemctl\s+(status|is-active|list-units|is-enabled)|docker\s+(ps|logs|inspect|images)|git\s+(status|log|diff|show))\b/;

export function classify(command: string, hosts: Hosts = []): Classification {
  const reasons: string[] = [];
  const check = (cmd: string) => {
    for (const [re, why] of PATTERNS) if (re.test(cmd) && !reasons.includes(why)) reasons.push(why);
  };
  check(command);

  const m = command.trim().match(SSH);
  if (m) {
    const host = m[2];
    const remote = (m[4] ?? m[5] ?? '').trim();
    check(remote);
    const prod = hosts.find((h) => h.alias === host)?.prod;
    const segments = remote.split(/&&|\|\||;|\|/);
    if (prod && remote && !segments.every((s) => READONLY.test(s) && !/>|\btee\b/.test(s))) reasons.push(`write on prod host ${host}`);
  }
  return { risky: reasons.length > 0, reasons };
}
