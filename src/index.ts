import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, type AppConfig } from "./config.js";
import { generateToken, ProjectsStore, scopeForProject, seedDefaultProject } from "./projects.js";
import { OAuthStore } from "./oauth.js";
import { AuditLog } from "./util/audit.js";
import { createServer } from "./server.js";
import { startHttpServer } from "./http.js";

function printBanner(lines: string[]): void {
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  const bar = "=".repeat(width);
  process.stderr.write(`\n${bar}\n`);
  for (const l of lines) process.stderr.write(`  ${l}\n`);
  process.stderr.write(`${bar}\n\n`);
}

function pickStdioProject(store: ProjectsStore) {
  return store.getDefault() ?? store.list()[0] ?? null;
}

async function main(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (e) {
    process.stderr.write(`Configuration error: ${(e as Error).message}\n`);
    process.exit(1);
  }

  const audit = new AuditLog(config.auditLogPath);
  const store = new ProjectsStore(config.projectsFile);
  const oauth = new OAuthStore(config.oauthFile);

  // Migration: seed the "default" project from legacy single-sandbox config
  // (keeps existing connector configs working).
  const seeded = seedDefaultProject(store, {
    root: config.seedRoot,
    token: config.seedToken,
    readOnly: config.readOnly,
    execEnabled: config.exec.enabled,
  });

  const adminToken = config.adminToken ?? generateToken();
  const adminTokenGenerated = !config.adminTokenProvided;

  if (config.stdio) {
    const project = pickStdioProject(store);
    if (!project) {
      process.stderr.write("No projects registered; cannot start stdio mode.\n");
      process.exit(1);
    }
    const scope = scopeForProject(project, {
      maxFileBytes: config.maxFileBytes,
      exec: config.exec,
      readOnly: config.readOnly,
    });
    const server = createServer(scope, audit);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write(
      `remote-sandbox-mcp stdio mode: project "${project.name}" (${project.slug}), root ${project.root}` +
        `${scope.readOnly ? ", read-only" : ""}${scope.exec.enabled ? ", exec on" : ", exec off"}\n`,
    );
    return;
  }

  const httpServer = startHttpServer({ config: { ...config, adminToken }, store, oauth, audit });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.port, config.host, () => resolve());
  });

  const banner = [
    `remote-sandbox-mcp listening on http://${config.host}:${config.port}`,
    `admin console: http://${config.host}:${config.port}/admin`,
    `audit log    : ${config.auditLogPath}`,
    `projects     : ${config.projectsFile}`,
    ``,
    `MCP endpoints:`,
  ];
  const defaultProject = store.getDefault();
  for (const p of store.list()) {
    const endpoint = defaultProject?.id === p.id ? `/${p.slug} + /mcp` : `/${p.slug}`;
    banner.push(`  ${endpoint}  ->  ${p.root}${p.readOnly ? "  [read-only]" : ""}${p.execEnabled ? "" : "  [exec off]"}`);
  }
  if (!defaultProject) {
    banner.push(`  (/mcp is unassigned - pick a project for it in the admin console)`);
  }
  banner.push(
    ``,
    `MCP auth     : ${config.auth}` +
      (config.auth === "none"
        ? "  (NO AUTHENTICATION - only safe on loopback / SSH port-forward)"
        : config.auth === "token"
          ? "  (project tokens only)"
          : "  (project tokens + OAuth)"),
  );
  if (config.auth === "any") {
    banner.push(
      ``,
      `OAuth (connector authorization, pick the project on the consent page):`,
      `  discovery    : /.well-known/oauth-protected-resource[/<slug>]  and  /.well-known/oauth-authorization-server`,
      `  authorize    : /oauth/authorize   (open in a browser, log in with the admin token)`,
      `  public origin: ${config.publicUrl ?? "(derived per request from Host / X-Forwarded-*)"}`,
      `  NOTE: a public tunnel must expose /.well-known/* and /oauth/* as well as the MCP endpoints.`,
    );
  } else {
    banner.push(``, `OAuth endpoints are disabled (--auth ${config.auth}); use the admin console or /api.`);
  }
  if (seeded?.tokenGenerated) {
    banner.push(
      ``,
      `NO TOKEN WAS CONFIGURED - generated a random token for the "default" project:`,
      `  MCP_TOKEN = ${seeded.project.token}`,
      `Set MCP_TOKEN env var or --token to use a fixed token.`,
    );
  }
  if (adminTokenGenerated) {
    banner.push(
      ``,
      `NO ADMIN TOKEN WAS CONFIGURED - generated a random one:`,
      `  MCP_ADMIN_TOKEN = ${adminToken}`,
      `Set MCP_ADMIN_TOKEN env var or --admin-token to use a fixed token.`,
    );
  }
  if (config.auth === "none") {
    banner.push(
      ``,
      `DANGER: auth mode "none" serves every MCP endpoint with NO authentication. Anyone who can reach`,
      `this port gets full read/write/exec access to every project root. Keep the listener on`,
      `127.0.0.1 (currently bound to ${config.host}) and never put it on a public tunnel.`,
    );
  } else {
    banner.push(
      ``,
      `WARNING: keep /admin and /api OFF public tunnels - expose only the MCP endpoints (/<slug>, /mcp)` +
        (config.auth === "any" ? ` (+ /.well-known/*, /oauth/* when using OAuth)` : ``),
    );
  }
  banner.push(`Access the console locally or via: ssh -L ${config.port}:127.0.0.1:${config.port} <server>`);
  printBanner(banner);

  const shutdown = (): void => {
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  process.stderr.write(`Fatal: ${(e as Error).stack ?? (e as Error).message}\n`);
  process.exit(1);
});
