interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Have I Been Pwned MCP
 *
 * Mixed-auth surface:
 * - check_password / check_password_prefix: free, no key (k-anonymity via
 *   pwnedpasswords.com). The password itself never leaves the worker — only
 *   the first 5 hex chars of its SHA-1.
 * - list_breaches / get_breach / list_data_classes: free, no key.
 * - check_account: requires a BYO HIBP subscription key (paid).
 *
 * Useful for: credential-stuffing risk checks, breach-history due diligence
 * on an email, password-rotation guidance.
 *
 * API: https://haveibeenpwned.com/API/v3
 */


const HIBP_BASE = 'https://haveibeenpwned.com/api/v3';
const PWNED_PWD_BASE = 'https://api.pwnedpasswords.com';
const USER_AGENT = 'Pipeworx-HIBP-MCP/0.1';

const tools: McpToolExport['tools'] = [
  {
    name: 'check_password',
    description:
      'Check whether a password appears in known breach corpora. Uses k-anonymity: the password is SHA-1ed locally, only the first 5 hex chars leave the worker, and the response is filtered to match the rest. Returns pwned count (0 = not seen). The password itself is never transmitted.',
    inputSchema: {
      type: 'object',
      properties: {
        password: { type: 'string', description: 'Password to check (stays inside the worker)' },
      },
      required: ['password'],
    },
  },
  {
    name: 'check_password_prefix',
    description:
      'Direct k-anonymity lookup: pass the first 5 hex chars of a SHA-1 password hash, get back all SHA-1 suffixes with their pwned counts. Use this if you\'re hashing client-side and only want to send the prefix.',
    inputSchema: {
      type: 'object',
      properties: {
        sha1_prefix: { type: 'string', description: '5 hexadecimal characters' },
      },
      required: ['sha1_prefix'],
    },
  },
  {
    name: 'list_breaches',
    description:
      'List all publicly-known data breaches catalogued by HIBP. Optionally filter to a specific domain (e.g., "linkedin.com"). Returns name, title, breach date, added date, affected accounts, description, data classes exposed, and verification status.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Restrict to a specific breached domain' },
      },
      required: [],
    },
  },
  {
    name: 'get_breach',
    description:
      'Fetch a single breach by name (the "Name" field from list_breaches, e.g., "Adobe", "LinkedIn"). Returns full breach metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Breach name (case-sensitive)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_data_classes',
    description: 'Canonical list of HIBP "data class" tags (e.g., "Email addresses", "Passwords", "Geographic locations"). Useful for filtering breaches.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'check_account',
    description:
      'Look up breaches an email account has been seen in. REQUIRES a paid HIBP subscription key (pass _apiKey). Returns the set of breach names; combine with get_breach for details.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Email address' },
        truncate: {
          type: 'boolean',
          description: 'Return only breach names (default true). Set false for full breach objects (counts as 1 query).',
        },
      },
      required: ['account'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'check_password':
      return checkPassword(String(args.password));
    case 'check_password_prefix':
      return checkPasswordPrefix(String(args.sha1_prefix));
    case 'list_breaches':
      return listBreaches(args.domain as string | undefined);
    case 'get_breach':
      return getBreach(String(args.name));
    case 'list_data_classes':
      return listDataClasses();
    case 'check_account':
      return checkAccount(
        (args._apiKey as string | undefined)?.trim(),
        String(args.account),
        (args.truncate as boolean | undefined) ?? true,
      );
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Password (k-anonymity) ────────────────────────────────────────────

async function sha1Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input));
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex.toUpperCase();
}

async function checkPassword(password: string) {
  if (!password) throw new Error('password is required');
  const hash = await sha1Hex(password);
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  const range = await fetchPwdRange(prefix);
  const match = range.get(suffix);
  return {
    pwned: match !== undefined,
    pwned_count: match ?? 0,
    sha1_prefix: prefix,
    advice:
      match && match > 0
        ? 'This password has been seen in known breaches and should not be used.'
        : 'This password has not been observed in HIBP\'s breach corpus.',
  };
}

async function checkPasswordPrefix(prefix: string) {
  if (!/^[0-9A-Fa-f]{5}$/.test(prefix)) {
    throw new Error('sha1_prefix must be exactly 5 hexadecimal characters');
  }
  const upper = prefix.toUpperCase();
  const range = await fetchPwdRange(upper);
  return {
    sha1_prefix: upper,
    suffix_count: range.size,
    suffixes: Array.from(range.entries()).map(([suffix, count]) => ({ suffix, count })),
  };
}

async function fetchPwdRange(prefix: string): Promise<Map<string, number>> {
  const res = await fetch(`${PWNED_PWD_BASE}/range/${prefix}`, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`HIBP pwned-passwords error: ${res.status}`);
  }
  const text = await res.text();
  const map = new Map<string, number>();
  for (const line of text.split('\n')) {
    const [suffix, count] = line.trim().split(':');
    if (suffix) map.set(suffix.toUpperCase(), Number(count));
  }
  return map;
}

// ── Breach catalog (free) ─────────────────────────────────────────────

async function hibpGet<T>(path: string, apiKey?: string): Promise<T> {
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
  if (apiKey) headers['hibp-api-key'] = apiKey;
  const res = await fetch(`${HIBP_BASE}${path}`, { headers });
  if (res.status === 401) throw new Error('HIBP: unauthorized — check the API key (account lookups require a paid subscription)');
  if (res.status === 404) {
    // For check_account, 404 means "no breaches for this account"
    return [] as unknown as T;
  }
  if (res.status === 429) throw new Error('HIBP: rate-limit hit (HTTP 429)');
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HIBP error: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

interface BreachRecord {
  Name?: string;
  Title?: string;
  Domain?: string;
  BreachDate?: string;
  AddedDate?: string;
  ModifiedDate?: string;
  PwnCount?: number;
  Description?: string;
  DataClasses?: string[];
  IsVerified?: boolean;
  IsFabricated?: boolean;
  IsSensitive?: boolean;
  IsRetired?: boolean;
  IsSpamList?: boolean;
  IsMalware?: boolean;
  LogoPath?: string;
}

function normalizeBreach(b: BreachRecord) {
  return {
    name: b.Name ?? null,
    title: b.Title ?? null,
    domain: b.Domain ?? null,
    breach_date: b.BreachDate ?? null,
    added_date: b.AddedDate ?? null,
    modified_date: b.ModifiedDate ?? null,
    pwn_count: b.PwnCount ?? null,
    description: b.Description ?? null,
    data_classes: b.DataClasses ?? [],
    is_verified: b.IsVerified ?? null,
    is_fabricated: b.IsFabricated ?? null,
    is_sensitive: b.IsSensitive ?? null,
    is_retired: b.IsRetired ?? null,
    is_spam_list: b.IsSpamList ?? null,
    is_malware: b.IsMalware ?? null,
    logo_path: b.LogoPath ?? null,
  };
}

async function listBreaches(domain: string | undefined) {
  const query = domain ? `?domain=${encodeURIComponent(domain)}` : '';
  const data = await hibpGet<BreachRecord[]>(`/breaches${query}`);
  return { count: data.length, breaches: data.map(normalizeBreach) };
}

async function getBreach(name: string) {
  const data = await hibpGet<BreachRecord>(`/breach/${encodeURIComponent(name)}`);
  return normalizeBreach(data);
}

async function listDataClasses() {
  const data = await hibpGet<string[]>('/dataclasses');
  return { count: data.length, data_classes: data };
}

// ── Account check (BYO key) ────────────────────────────────────────────

async function checkAccount(apiKey: string | undefined, account: string, truncate: boolean) {
  if (!apiKey) {
    throw new Error(
      'check_account requires a BYO HIBP subscription key (paid). Pass ?_apiKey=<key>. The free password / breach-list tools work without a key.',
    );
  }
  const params = new URLSearchParams({ truncateResponse: String(truncate) });
  const data = await hibpGet<BreachRecord[] | { Name: string }[]>(
    `/breachedaccount/${encodeURIComponent(account)}?${params}`,
    apiKey,
  );
  if (Array.isArray(data) && data.length === 0) {
    return { account, pwned: false, breaches: [] };
  }
  if (truncate) {
    const names = (data as { Name: string }[]).map((b) => b.Name);
    return { account, pwned: names.length > 0, breach_names: names };
  }
  return { account, pwned: data.length > 0, breaches: (data as BreachRecord[]).map(normalizeBreach) };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
