import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ExecConfig {
  enabled: boolean;
  timeoutMs: number;
  allow: string[];
  deny: string[];
}

/** The sandbox-related configuration a tool handler needs (per project). */
export interface ToolScope {
  root: string;
  maxFileBytes: number;
  readOnly: boolean;
  exec: ExecConfig;
}

export interface AppConfig {
  host: string;
  port: number;
  /** Admin console / API token. Null means "generate at startup and print". */
  adminToken: string | null;
  adminTokenProvided: boolean;
  maxFileBytes: number;
  /** Master switch: forces every project read-only. */
  readOnly: boolean;
  stdio: boolean;
  /** Global exec defaults; exec.enabled=false is a master switch for all projects. */
  exec: ExecConfig;
  projectDir: string;
  auditLogPath: string;
  dataDir: string;
  projectsFile: string;
  publicDir: string;
  /** Seed sources for the initial "default" project (from CLI/env/config file). */
  seedRoot: string;
  seedToken: string | null;
}

interface CliArgs {
  root?: string;
  port?: number;
  host?: string;
  token?: string;
  adminToken?: string;
  stdio?: boolean;
  readOnly?: boolean;
  noExec?: boolean;
  config?: string;
}

const DEFAULTS = {
  root: "./sandbox",
  host: "127.0.0.1",
  port: 8787,
  maxFileBytes: 5 * 1024 * 1024,
  execTimeoutMs: 30_000,
};

export function parseCliArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--root":
        out.root = next();
        break;
      case "--port":
        out.port = Number(next());
        if (!Number.isInteger(out.port) || out.port <= 0 || out.port > 65535) {
          throw new Error(`Invalid --port value`);
        }
        break;
      case "--host":
        out.host = next();
        break;
      case "--token":
        out.token = next();
        break;
      case "--admin-token":
        out.adminToken = next();
        break;
      case "--stdio":
        out.stdio = true;
        break;
      case "--readonly":
        out.readOnly = true;
        break;
      case "--no-exec":
        out.noExec = true;
        break;
      case "--config":
        out.config = next();
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${a} (use --help)`);
    }
  }
  return out;
}

function printHelp(): void {
  process.stderr.write(`remote-sandbox-mcp

Usage: node dist/index.js [options]

Options:
  --root <dir>        Seed root for the initial "default" project (default ./sandbox)
  --port <n>          HTTP port (default 8787)
  --host <addr>       HTTP bind address (default 127.0.0.1)
  --token <token>     Seed token for the initial "default" project
  --admin-token <t>   Admin console / API token (default: random, printed at startup)
  --stdio             Serve MCP over stdio (uses the "default" project) instead of HTTP
  --readonly          Master switch: every project becomes read-only
  --no-exec           Master switch: disable exec_run for all projects
  --config <path>     Config file path (default ./sandbox.config.json)
  --help              Show this help

Environment: MCP_ROOT, MCP_PORT, MCP_HOST, MCP_TOKEN, MCP_ADMIN_TOKEN
Priority: CLI args > env > config file > defaults

MCP endpoints: /mcp (default project) and /mcp/<slug> per project.
Admin console: /admin (use only via local access or SSH port-forward).
`);
}

interface FileConfig {
  root?: string;
  host?: string;
  port?: number;
  token?: string;
  adminToken?: string;
  maxFileBytes?: number;
  readOnly?: boolean;
  exec?: {
    enabled?: boolean;
    timeoutMs?: number;
    allow?: string[];
    deny?: string[];
  };
}

function loadConfigFile(projectDir: string, explicitPath?: string): FileConfig {
  const p = explicitPath
    ? path.resolve(projectDir, explicitPath)
    : path.join(projectDir, "sandbox.config.json");
  if (!fs.existsSync(p)) return {};
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (e) {
    throw new Error(`Cannot read config file ${p}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(raw) as FileConfig;
  } catch (e) {
    throw new Error(`Invalid JSON in config file ${p}: ${(e as Error).message}`);
  }
}

/** public/ sits next to dist/ (built) or src/ (tsx dev): one level up from this module. */
function defaultPublicDir(): string {
  return fileURLToPath(new URL("../public", import.meta.url));
}

export function loadConfig(argv: string[] = process.argv.slice(2)): AppConfig {
  const projectDir = process.cwd();
  const cli = parseCliArgs(argv);
  const env = process.env;
  const file = loadConfigFile(projectDir, cli.config);

  const host = cli.host ?? env.MCP_HOST ?? file.host ?? DEFAULTS.host;

  const portRaw = cli.port ?? (env.MCP_PORT ? Number(env.MCP_PORT) : undefined) ?? file.port ?? DEFAULTS.port;
  if (!Number.isInteger(portRaw) || portRaw <= 0 || portRaw > 65535) {
    throw new Error(`Invalid port: ${portRaw}`);
  }

  const seedTokenRaw = cli.token ?? env.MCP_TOKEN ?? file.token ?? null;
  const seedToken = seedTokenRaw && seedTokenRaw.trim().length > 0 ? seedTokenRaw : null;

  const adminTokenRaw = cli.adminToken ?? env.MCP_ADMIN_TOKEN ?? file.adminToken ?? null;
  const adminToken = adminTokenRaw && adminTokenRaw.trim().length > 0 ? adminTokenRaw : null;

  const maxFileBytes = file.maxFileBytes ?? DEFAULTS.maxFileBytes;
  if (!Number.isInteger(maxFileBytes) || maxFileBytes <= 0) {
    throw new Error(`Invalid maxFileBytes: ${maxFileBytes}`);
  }

  const readOnly = cli.readOnly ?? file.readOnly ?? false;
  const execEnabled = cli.noExec ? false : (file.exec?.enabled ?? true);

  const config: AppConfig = {
    host,
    port: portRaw,
    adminToken,
    adminTokenProvided: adminToken !== null,
    maxFileBytes,
    readOnly,
    stdio: cli.stdio ?? false,
    exec: {
      enabled: execEnabled,
      timeoutMs: file.exec?.timeoutMs ?? DEFAULTS.execTimeoutMs,
      allow: file.exec?.allow ?? [],
      deny: file.exec?.deny ?? [],
    },
    projectDir,
    auditLogPath: path.join(projectDir, "logs", "audit.jsonl"),
    dataDir: path.join(projectDir, "data"),
    projectsFile: path.join(projectDir, "data", "projects.json"),
    publicDir: defaultPublicDir(),
    seedRoot: "",
    seedToken,
  };

  // Validate exec.allow / exec.deny are valid regexes early.
  for (const [name, list] of [
    ["exec.allow", config.exec.allow],
    ["exec.deny", config.exec.deny],
  ] as const) {
    for (const pattern of list) {
      try {
        new RegExp(pattern);
      } catch (e) {
        throw new Error(`Invalid regex in ${name}: ${pattern} (${(e as Error).message})`);
      }
    }
  }

  // Resolve the seed root (auto-create like before).
  const rootInput = cli.root ?? env.MCP_ROOT ?? file.root ?? DEFAULTS.root;
  const seedRoot = path.resolve(projectDir, rootInput);
  if (!fs.existsSync(seedRoot)) {
    fs.mkdirSync(seedRoot, { recursive: true });
  }
  if (!fs.statSync(seedRoot).isDirectory()) {
    throw new Error(`Seed root is not a directory: ${seedRoot}`);
  }
  config.seedRoot = fs.realpathSync(seedRoot);

  return config;
}
