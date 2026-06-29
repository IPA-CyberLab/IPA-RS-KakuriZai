// @ts-nocheck
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { hashPassword } from "./auth/password.js";
import { createAuthProvider } from "./auth/providers.js";
import { generateTotpSecret, totpAuthUrl } from "./auth/totp.js";
import { commandExists } from "./core/fs.js";
import { parseBooleanOption } from "./core/network.js";
import { initConfigFile, loadConfig } from "./core/config.js";
import { runCommand } from "./core/process.js";
import {
  readSandboxManifest,
  stringifySandboxManifest,
  worldToManifest,
  writeTerraformBundle
} from "./core/spec.js";
import {
  applyWorld,
  changedPaths,
  createKubernetesLab,
  createWorld,
  execWorld,
  getWorld,
  listWorlds,
  openWorld,
  pauseWorld,
  removeWorld,
  resumeWorld,
  upsertWorldFromManifest
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
  if (command === "pause") return pause(config, argv.slice(1));
  if (command === "resume") return resume(config, argv.slice(1));
  if (command === "open") return open(config, argv.slice(1));
  if (["file", "terminal", "vscode", "agent"].includes(command)) {
    return open(config, [argv[1], command, ...argv.slice(2)]);
  }
  if (command === "changed") return changed(config, argv.slice(1));
  if (command === "apply") return apply(config, argv.slice(1));
  if (command === "lab") return lab(config, argv.slice(1));
  if (command === "k8s-lab") return kubernetesLab(config, argv.slice(1));
  if (command === "export" || command === "manifest") return manifest(config, argv.slice(1));
  if (command === "terraform") return terraform(config, argv.slice(1));
  if (command === "auth") return auth(config, argv.slice(1));
  if (command === "studio") return studio(config, argv.slice(1));
  if (command === "exec" || command === "shell") {
    return worldOrDelegate(config, command, argv.slice(1));
  }
  return delegateToIsolatedAgent(config, argv);
}

function help() {
  console.log(`agctl

Sandbox commands:
  agctl create --source <folder> --name <name> [--backend cube-sandbox-overlay]
  agctl create --name <name> --no-host-mount [--network tap] [--expose-port 6443]
  agctl lab kubernetes --name <name> [--control-planes 1] [--workers 2] [--json]
  agctl apply -f sandbox.yaml [--json]
  agctl export <sandbox> --yaml
  agctl terraform export <sandbox|--file sandbox.yaml> --out ./terraform
  agctl list [--json]
  agctl show <sandbox> [--json]
  agctl open <sandbox> <file|terminal|vscode|agent>
  agctl file <sandbox>
  agctl terminal <sandbox>
  agctl vscode <sandbox>
  agctl agent <sandbox>
  agctl exec <sandbox> -- <command...>
  agctl shell <sandbox>
  agctl changed <sandbox> [--json]
  agctl apply <sandbox> [--dry-run] [--json]
  agctl lab kubernetes --name <name> [--json]
  agctl pause <sandbox> [--json]
  agctl resume <sandbox> [--json]
  agctl remove <sandbox> --yes
  agctl studio [--host 127.0.0.1] [--port 38476]
  agctl auth token [--subject local-user] [--role admin|operator|viewer] [--ttl 28800]
  agctl auth password-hash --password <password>
  agctl auth totp-secret [--subject local-user]

Unknown commands are delegated to IPA-RS-IsolatedAgent agentctl when available.`);
}

async function init() {
  const result = await initConfigFile();
  console.log(result.created ? `created ${result.configPath}` : `exists ${result.configPath}`);
}

async function create(config, args) {
  const sourcePath = takeOption(args, "--source") || takeOption(args, "-s");
  const mountOptions = takeRepeatedOption(args, "--mount").map(parseMountOption);
  const name = takeOption(args, "--name") || takeOption(args, "-n");
  const backend = takeOption(args, "--backend") || config.defaultBackend;
  const noHostMount = takeFlag(args, "--no-host-mount");
  const networkType = takeOption(args, "--network") || takeOption(args, "--network-type");
  const exposedPorts = takeRepeatedOption(args, "--expose-port");
  const dnsServers = takeRepeatedOption(args, "--dns");
  const allowInternet = takeOption(args, "--allow-internet-access");
  const kubernetes = takeFlag(args, "--kubernetes") || takeFlag(args, "--k8s");
  if (!name) throw new Error("create requires --name");
  if (!sourcePath && mountOptions.length === 0 && !noHostMount) throw new Error("create requires --source or --mount unless --no-host-mount is set");
  const mounts = [
    ...mountOptions,
    ...(sourcePath ? [{ sourcePath, mode: undefined }] : [])
  ].map((mount) => ({ ...mount, mode: mount.mode || undefined }));
  const world = await createWorld(config, {
    sourcePath,
    mounts: mounts.length ? mounts : undefined,
    name,
    backend,
    hostMount: !noHostMount,
    networkType,
    network: {
      type: networkType,
      exposedPorts,
      dns: { servers: dnsServers },
      ...(allowInternet == null ? {} : { allowInternetAccess: parseBooleanOption(allowInternet) })
    },
    kubernetes: { enabled: kubernetes }
  });
  printWorld(world);
}

async function list(config, args) {
  const worlds = await listWorlds(config);
  if (args.includes("--json")) {
    console.log(JSON.stringify(worlds, null, 2));
    return;
  }
  if (worlds.length === 0) {
    console.log("no sandboxes");
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
  if (!ref) throw new Error("show requires a sandbox name or id");
  const world = await getWorld(config, ref);
  if (args.includes("--json")) {
    console.log(JSON.stringify(world, null, 2));
    return;
  }
  printDetails(world);
}

async function remove(config, args) {
  const ref = args.find((arg) => !arg.startsWith("-"));
  if (!ref) throw new Error("remove requires a sandbox name or id");
  if (!args.includes("--yes")) await confirmRemove(ref);
  const world = await removeWorld(config, ref);
  if (args.includes("--json")) {
    console.log(JSON.stringify(world, null, 2));
    return;
  }
  console.log(`removed ${world.name}`);
}

async function pause(config, args) {
  const ref = args.find((arg) => !arg.startsWith("-"));
  if (!ref) throw new Error("pause requires a sandbox id");
  const result = await pauseWorld(config, ref);
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!result.applied) throw new Error(result.reason || `failed to pause ${result.world.name}`);
  console.log(`paused ${result.world.name}`);
}

async function resume(config, args) {
  const ref = args.find((arg) => !arg.startsWith("-"));
  if (!ref) throw new Error("resume requires a sandbox id");
  const result = await resumeWorld(config, ref);
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!result.applied) throw new Error(result.reason || `failed to resume ${result.world.name}`);
  console.log(`resumed ${result.world.name}`);
}

async function open(config, args) {
  const [ref, target] = args;
  if (!ref || !target) throw new Error("open requires <sandbox> <target>");
  const result = await openWorld(config, ref, target);
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`opened ${target} for ${result.world.name}`);
}

async function changed(config, args) {
  const [ref] = args;
  if (!ref) throw new Error("changed requires <sandbox>");
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
  const file = takeOption(args, "-f") || takeOption(args, "--file");
  if (file) return applyManifest(config, file, args);
  const ref = args.find((arg) => !arg.startsWith("-"));
  if (!ref) throw new Error("apply requires <sandbox>");
  const result = await applyWorld(config, ref, { dryRun: args.includes("--dry-run") });
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const change of result.changes) {
    console.log(`${result.applied ? "applied" : "would-apply"}\t${change.action}\t${change.path}`);
  }
}

async function applyManifest(config, file, args) {
  const manifest = await readSandboxManifest(file);
  const result = await upsertWorldFromManifest(config, manifest);
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${result.action} ${result.world.name}`);
}

async function lab(config, args) {
  const subcommand = args.shift();
  if (subcommand === "kubernetes" || subcommand === "k8s") return kubernetesLab(config, args);
  throw new Error("lab supports: kubernetes");
}

async function kubernetesLab(config, args) {
  const name = takeOption(args, "--name") || takeOption(args, "-n");
  if (!name) throw new Error("lab kubernetes requires --name");
  const controlPlanes = takeOption(args, "--control-planes") || takeOption(args, "--control-plane-count");
  const workers = takeOption(args, "--workers") || takeOption(args, "--worker-count");
  const writableLayerSize = takeOption(args, "--writable-layer-size") || takeOption(args, "--disk");
  const apiServerPort = takeOption(args, "--api-server-port");
  const nodePorts = [
    ...splitOptionValues(takeRepeatedOption(args, "--node-port")),
    ...splitOptionValues(takeRepeatedOption(args, "--node-ports"))
  ];
  const allowInternet = takeOption(args, "--allow-internet-access");
  const result = await createKubernetesLab(config, {
    name,
    controlPlanes: controlPlanes == null ? undefined : Number(controlPlanes),
    workers: workers == null ? undefined : Number(workers),
    cpu: takeOption(args, "--cpu") || undefined,
    memory: takeOption(args, "--memory") || undefined,
    writableLayerSize: writableLayerSize || undefined,
    profile: takeOption(args, "--profile") || undefined,
    cni: takeOption(args, "--cni") || undefined,
    podCidr: takeOption(args, "--pod-cidr") || undefined,
    serviceCidr: takeOption(args, "--service-cidr") || undefined,
    apiServerPort: apiServerPort == null ? undefined : Number(apiServerPort),
    nodePorts: nodePorts.length ? nodePorts.map(Number) : undefined,
    joinToken: takeOption(args, "--join-token") || undefined,
    joinEndpoint: takeOption(args, "--join-endpoint") || undefined,
    extraArgs: [
      ...takeRepeatedOption(args, "--extra-arg"),
      ...splitOptionValues(takeRepeatedOption(args, "--extra-args"))
    ],
    sysctls: parseKeyValueOptions(takeRepeatedOption(args, "--sysctl")),
    network: {
      type: "tap",
      mode: takeOption(args, "--network-mode") || "tap",
      ...(allowInternet == null ? {} : { allowInternetAccess: parseBooleanOption(allowInternet) }),
      allowOut: splitOptionValues(takeRepeatedOption(args, "--allow-out-cidr")),
      denyOut: splitOptionValues(takeRepeatedOption(args, "--deny-out-cidr"))
    }
  });
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`created Kubernetes lab ${result.lab.name}`);
  for (const world of result.worlds) {
    console.log(`${world.name}\t${world.status}\t${world.sandbox?.id || world.sandbox?.status || "none"}`);
  }
}

async function manifest(config, args) {
  const ref = args.find((arg) => !arg.startsWith("-"));
  if (!ref) throw new Error("export requires a sandbox name or id");
  const world = await getWorld(config, ref);
  const output = takeOption(args, "--out") || takeOption(args, "-o");
  const yaml = stringifySandboxManifest(worldToManifest(world));
  if (output) {
    await fs.writeFile(output, yaml, "utf8");
    console.log(`wrote ${output}`);
    return;
  }
  if (args.includes("--json")) console.log(JSON.stringify(worldToManifest(world), null, 2));
  else console.log(yaml);
}

async function terraform(config, args) {
  const subcommand = args[0] || "export";
  if (subcommand !== "export" && subcommand !== "bundle") {
    throw new Error("terraform supports: export <sandbox|--file manifest.yaml> --out <dir>");
  }
  args.shift();
  const outDir = takeOption(args, "--out") || takeOption(args, "-o") || "kakurizai-terraform";
  const file = takeOption(args, "--file") || takeOption(args, "-f");
  let sandboxManifest;
  if (file) {
    sandboxManifest = await readSandboxManifest(file);
  } else {
    const ref = args.find((arg) => !arg.startsWith("-"));
    if (!ref) throw new Error("terraform export requires <sandbox> or --file <manifest.yaml>");
    sandboxManifest = worldToManifest(await getWorld(config, ref));
  }
  const result = await writeTerraformBundle(sandboxManifest, outDir);
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`wrote ${result.outDir}`);
  for (const filePath of result.files) console.log(filePath);
}

async function auth(config, args) {
  const subcommand = args.shift();
  if (subcommand === "password-hash") {
    const password = takeOption(args, "--password") || (args.includes("--stdin") ? (await readStdin()).trimEnd() : null);
    if (!password) throw new Error("auth password-hash requires --password <password> or --stdin");
    console.log(hashPassword(password));
    return;
  }
  if (subcommand === "totp-secret") {
    const subject = takeOption(args, "--subject") || "local-user";
    const secret = generateTotpSecret();
    const issuer = config.auth?.totp?.issuer || "KakuriZai";
    console.log(JSON.stringify({
      subject,
      secret,
      otpauth: totpAuthUrl({ issuer, subject, secret })
    }, null, 2));
    return;
  }
  if (subcommand !== "token") throw new Error("auth supports: token, password-hash, totp-secret");
  const provider = createAuthProvider(config.auth);
  if (provider.type !== "self") throw new Error("auth token is only available for self provider");
  const subject = takeOption(args, "--subject") || "local-user";
  const ttl = Number(takeOption(args, "--ttl") || 8 * 60 * 60);
  const roles = splitOptionValues(takeRepeatedOption(args, "--role"));
  const permissions = splitOptionValues(takeRepeatedOption(args, "--permission"));
  const scope = splitOptionValues(takeRepeatedOption(args, "--scope"));
  console.log(provider.issueToken({
    subject,
    expiresInSeconds: ttl,
    roles: roles.length ? roles : ["admin"],
    permissions: permissions.length ? permissions : undefined,
    scope: scope.length ? scope : undefined
  }));
}

async function studio(config, args) {
  const host = takeOption(args, "--host") || config.studio.host;
  const port = Number(takeOption(args, "--port") || config.studio.port);
  const server = await startStudio({ ...config, studio: { ...config.studio, host, port } });
  console.log(`Agent Studio listening on ${server.url}`);
  if (server.auth?.requiresToken) {
    console.log("Sign in with a bearer token from: agctl auth token");
  }
  if ((host === "0.0.0.0" || host === "::") && !server.tls) {
    console.log("Warning: Studio is listening on a non-loopback interface without built-in TLS. Put it behind HTTPS or configure studio.tls before exposing it to the internet.");
  }
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

function takeRepeatedOption(args, name) {
  const values = [];
  for (;;) {
    const value = takeOption(args, name);
    if (value == null) break;
    values.push(value);
  }
  return values;
}

function takeFlag(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function splitOptionValues(values) {
  return values
    .flatMap((value) => String(value || "").split(/[,\n\s]+/))
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseKeyValueOptions(values) {
  const result = {};
  for (const item of values) {
    const separator = String(item || "").indexOf("=");
    if (separator <= 0) throw new Error(`expected key=value: ${item}`);
    const key = String(item).slice(0, separator).trim();
    const value = String(item).slice(separator + 1).trim();
    if (!key || !value) throw new Error(`expected key=value: ${item}`);
    result[key] = value;
  }
  return result;
}

function parseMountOption(value) {
  const input = String(value || "").trim();
  const modeMatch = /:(agctl-overlay|cubesandbox-readonly|unsafe-rw)$/.exec(input);
  const withoutMode = modeMatch ? input.slice(0, -modeMatch[0].length) : input;
  const equals = withoutMode.indexOf("=");
  if (equals > 0) {
    return {
      name: withoutMode.slice(0, equals),
      sourcePath: withoutMode.slice(equals + 1),
      mode: modeMatch?.[1]
    };
  }
  return {
    sourcePath: withoutMode,
    mode: modeMatch?.[1]
  };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
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
    ["Runtime", world.backend],
    ["Sandbox ID", world.sandbox?.id || world.sandbox?.status || "none"],
    ["Base template", world.sandbox?.baseId || "none"],
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
