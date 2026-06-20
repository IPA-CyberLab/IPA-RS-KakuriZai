// @ts-nocheck
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { createAuthProvider } from "./auth/providers.js";
import { commandExists } from "./core/fs.js";
import { initConfigFile, loadConfig } from "./core/config.js";
import { runCommand } from "./core/process.js";
import {
  applyWorld,
  changedPaths,
  createWorld,
  execWorld,
  getWorld,
  listWorlds,
  openWorld,
  removeWorld
} from "./core/worlds.js";
import { startStudio } from "./server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function main(argv) {
  const command = argv[0] || "help";
  if (command === "help" || command === "--help" || command === "-h") return help();
  const config = await loadConfig();
  if (command === "init") return init();
  if (command === "create") return create(config, argv.slice(1));
  if (command === "list") return list(config, argv.slice(1));
  if (command === "show" || command === "inspect" || command === "details") return show(config, argv.slice(1));
  if (command === "remove") return remove(config, argv.slice(1));
  if (command === "open") return open(config, argv.slice(1));
  if (["file", "terminal", "vscode", "agent"].includes(command)) {
    return open(config, [argv[1], command, ...argv.slice(2)]);
  }
  if (command === "changed") return changed(config, argv.slice(1));
  if (command === "apply") return apply(config, argv.slice(1));
  if (command === "auth") return auth(config, argv.slice(1));
  if (command === "studio") return studio(config, argv.slice(1));
  if (command === "exec" || command === "shell") {
    return worldOrDelegate(config, command, argv.slice(1));
  }
  return delegateToIsolatedAgent(config, argv);
}

function help() {
  console.log(`agctl

World commands:
  agctl create --source <folder> --name <name> [--backend cube-sandbox-overlay]
  agctl list [--json]
  agctl show <world> [--json]
  agctl open <world> <file|terminal|vscode|agent>
  agctl file <world>
  agctl terminal <world>
  agctl vscode <world>
  agctl agent <world>
  agctl exec <world> -- <command...>
  agctl shell <world>
  agctl changed <world> [--json]
  agctl apply <world> [--dry-run] [--json]
  agctl remove <world> --yes
  agctl studio [--host 127.0.0.1] [--port 38476]
  agctl auth token [--subject local-user]

Unknown commands are delegated to IPA-RS-IsolatedAgent agentctl when available.`);
}

async function init() {
  const result = await initConfigFile();
  console.log(result.created ? `created ${result.configPath}` : `exists ${result.configPath}`);
}

async function create(config, args) {
  const sourcePath = takeOption(args, "--source") || takeOption(args, "-s");
  const name = takeOption(args, "--name") || takeOption(args, "-n");
  const backend = takeOption(args, "--backend") || config.defaultBackend;
  if (!sourcePath || !name) throw new Error("create requires --source and --name");
  const world = await createWorld(config, { sourcePath, name, backend });
  printWorld(world);
}

async function list(config, args) {
  const worlds = await listWorlds(config);
  if (args.includes("--json")) {
    console.log(JSON.stringify(worlds, null, 2));
    return;
  }
  if (worlds.length === 0) {
    console.log("no worlds");
    return;
  }
  for (const world of worlds) {
    console.log([
      world.name,
      world.status,
      world.backend,
      world.sandbox?.id || world.sandbox?.status || "none",
      formatBytes(world.diskUsage?.upperBytes || 0),
      String((world.sessions || []).length),
      world.sourcePath
    ].join("\t"));
  }
}

async function show(config, args) {
  const ref = args.find((arg) => !arg.startsWith("-"));
  if (!ref) throw new Error("show requires a world name or id");
  const world = await getWorld(config, ref);
  if (args.includes("--json")) {
    console.log(JSON.stringify(world, null, 2));
    return;
  }
  printDetails(world);
}

async function remove(config, args) {
  const ref = args.find((arg) => !arg.startsWith("-"));
  if (!ref) throw new Error("remove requires a world name or id");
  if (!args.includes("--yes")) await confirmRemove(ref);
  const world = await removeWorld(config, ref);
  if (args.includes("--json")) {
    console.log(JSON.stringify(world, null, 2));
    return;
  }
  console.log(`removed ${world.name}`);
}

async function open(config, args) {
  const [ref, target] = args;
  if (!ref || !target) throw new Error("open requires <world> <target>");
  const result = await openWorld(config, ref, target);
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`opened ${target} for ${result.world.name}`);
}

async function changed(config, args) {
  const [ref] = args;
  if (!ref) throw new Error("changed requires <world>");
  const changes = await changedPaths(config, ref);
  if (args.includes("--json")) {
    console.log(JSON.stringify(changes, null, 2));
    return;
  }
  for (const change of changes) {
    console.log(`${change.action}\t${change.path}`);
  }
}

async function apply(config, args) {
  const ref = args.find((arg) => !arg.startsWith("-"));
  if (!ref) throw new Error("apply requires <world>");
  const result = await applyWorld(config, ref, { dryRun: args.includes("--dry-run") });
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const change of result.changes) {
    console.log(`${result.applied ? "applied" : "would-apply"}\t${change.action}\t${change.path}`);
  }
}

async function auth(config, args) {
  if (args[0] !== "token") throw new Error("auth supports: token");
  const provider = createAuthProvider(config.auth);
  if (provider.type !== "self") throw new Error("auth token is only available for self provider");
  const subject = takeOption(args, "--subject") || "local-user";
  const ttl = Number(takeOption(args, "--ttl") || 8 * 60 * 60);
  console.log(provider.issueToken({ subject, expiresInSeconds: ttl }));
}

async function studio(config, args) {
  const host = takeOption(args, "--host") || config.studio.host;
  const port = Number(takeOption(args, "--port") || config.studio.port);
  const server = await startStudio({ ...config, studio: { ...config.studio, host, port } });
  console.log(`Agent Studio listening on ${server.url}`);
}

async function worldOrDelegate(config, command, args) {
  const ref = args[0];
  if (!ref) return delegateToIsolatedAgent(config, [command, ...args]);
  try {
    if (command === "shell") {
      return execWorld(config, ref, [process.env.SHELL || "bash"], { inherit: true, tty: true });
    }
    const separator = args.indexOf("--");
    const execArgs = separator >= 0 ? args.slice(separator + 1) : args.slice(1);
    if (execArgs.length === 0) throw new Error("exec requires a command after --");
    return execWorld(config, ref, execArgs, { inherit: true });
  } catch (error) {
    if (!/world not found/.test(error.message)) throw error;
    return delegateToIsolatedAgent(config, [command, ...args]);
  }
}

async function delegateToIsolatedAgent(config, args) {
  const binary = commandExists(config.isolatedAgent.agentctl) || commandExists("agentctl");
  if (binary) return runCommand(binary, args, { inherit: true });
  const cargo = commandExists("cargo");
  const manifest = path.resolve(__dirname, "..", config.isolatedAgent.sourceTree, "Cargo.toml");
  if (cargo) {
    return runCommand(cargo, ["run", "--manifest-path", manifest, "-p", "agentctl", "--", ...args], {
      inherit: true
    });
  }
  throw new Error("agentctl is unavailable; install IPA-RS-IsolatedAgent or set AGCTL_AGENTCTL");
}

function takeOption(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  return args.splice(index, 2)[1] || null;
}

function printWorld(world) {
  console.log(JSON.stringify({
    id: world.id,
    name: world.name,
    status: world.status,
    backend: world.backend,
    sourcePath: world.sourcePath,
    sandbox: world.sandbox
  }, null, 2));
}

function printDetails(world) {
  const rows = [
    ["Name", world.name],
    ["ID", world.id],
    ["Status", world.status],
    ["Source", world.sourcePath],
    ["Backend", world.backend],
    ["Sandbox", world.sandbox?.id || world.sandbox?.status || "none"],
    ["Base", world.sandbox?.baseId || "none"],
    ["Upper", world.paths?.upper || "none"],
    ["Disk", `${formatBytes(world.diskUsage?.upperBytes || 0)} upper`],
    ["Sessions", String((world.sessions || []).length)],
    ["Updated", world.updatedAt]
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) {
    console.log(`${label.padEnd(width)}  ${value || ""}`);
  }
}

async function confirmRemove(ref) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("remove requires --yes when not running interactively");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Remove ${ref}? Type "yes" to confirm: `);
    if (answer !== "yes") throw new Error("remove cancelled");
  } finally {
    rl.close();
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
