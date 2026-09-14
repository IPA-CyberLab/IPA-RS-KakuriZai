// @ts-nocheck
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, pathExists, readJson, removePath, slugify, walkFiles, writeJsonAtomic } from "./fs.js";

const MAX_TEMPLATE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TEMPLATE_BYTES = 16 * 1024 * 1024;
const SKIPPED_DIRECTORIES = new Set([".git", ".terraform", "node_modules"]);

export class SandboxTemplateStore {
  constructor(config) {
    this.config = config;
    this.root = path.join(config.storeDir, "templates");
  }

  async init() {
    await ensureDir(this.root);
  }

  async ensureDefault(options = {}) {
    await this.init();
    const existing = (await this.listMetadata()).find((template) => template.slug === "developer-sandbox");
    if (existing) return publicTemplate(existing);
    return this.push({
      name: "developer-sandbox",
      displayName: "Developer sandbox",
      description: "Standard isolated development sandbox",
      files: { "main.tf": starterSandboxTemplate(options) }
    });
  }

  async list() {
    await this.init();
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    const templates = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metadata = await readJson(path.join(this.root, entry.name, "template.json"), null).catch(() => null);
      if (metadata?.id) templates.push(publicTemplate(metadata));
    }
    return templates.sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  async get(ref) {
    const value = String(ref || "").trim();
    const templates = await this.listMetadata();
    const exact = templates.find((template) => template.id === value || template.slug === value);
    if (exact) return publicTemplate(exact);
    const byName = templates.filter((template) => template.name === value || template.displayName === value);
    if (byName.length === 1) return publicTemplate(byName[0]);
    const error = new Error(byName.length > 1 ? `ambiguous template: ${value}` : `template not found: ${value}`);
    error.statusCode = byName.length > 1 ? 409 : 404;
    throw error;
  }

  async getWithSource(ref) {
    const template = await this.get(ref);
    const sourceDir = this.versionDirectory(template.id, template.activeVersion);
    const files = {};
    const sourceFiles = [];
    for await (const entry of walkFiles(sourceDir)) {
      if (entry.type !== "file") continue;
      const relativePath = normalizeRelativePath(entry.relativePath);
      const stat = await fs.stat(entry.path);
      sourceFiles.push({ path: relativePath, size: stat.size, text: isTextTemplateFile(relativePath) });
      if (isTextTemplateFile(relativePath) && stat.size <= MAX_TEMPLATE_FILE_BYTES) {
        files[relativePath] = await fs.readFile(entry.path, "utf8");
      }
    }
    return { ...template, files, sourceFiles };
  }

  async push(input = {}) {
    await this.init();
    const name = cleanTemplateName(input.name);
    const slug = slugify(input.slug || name);
    const existing = (await this.listMetadata()).find((template) => template.slug === slug) || null;
    const id = existing?.id || `kzt-${crypto.randomBytes(8).toString("hex")}`;
    const collected = input.directory
      ? await collectDirectoryFiles(path.resolve(input.directory))
      : collectInlineFiles(input.files || {});
    if (!collected.has("main.tf")) throw badRequest("template source must contain main.tf at its root");
    const terraformFiles = [...collected.entries()]
      .filter(([file]) => file.endsWith(".tf"))
      .map(([file, content]) => ({ file, text: content.toString("utf8") }));
    const parameters = inspectTerraformVariables(terraformFiles);
    const nameParameter = parameters.find((parameter) => parameter.name === "name");
    if (!nameParameter || !isStringType(nameParameter.type)) {
      throw badRequest('template must declare variable "name" with type string');
    }
    const sourceHash = hashFiles(collected);
    const version = sourceHash.slice(0, 12);
    const versionDir = this.versionDirectory(id, version);
    if (!await pathExists(versionDir)) {
      const temporary = `${versionDir}.${process.pid}.${Date.now()}.tmp`;
      await ensureDir(temporary);
      try {
        for (const [relativePath, content] of collected) {
          const destination = path.join(temporary, relativePath);
          await ensureDir(path.dirname(destination));
          await fs.writeFile(destination, content, { mode: executableTemplateFile(relativePath) ? 0o700 : 0o600 });
        }
        await ensureDir(path.dirname(versionDir));
        await fs.rename(temporary, versionDir);
      } catch (error) {
        await removePath(temporary);
        throw error;
      }
    }
    const now = new Date().toISOString();
    const versions = dedupeVersions([
      ...(existing?.versions || []),
      { version, sourceHash, createdAt: now, fileCount: collected.size, sizeBytes: totalFileBytes(collected) }
    ]);
    const metadata = {
      version: 1,
      id,
      slug,
      name,
      displayName: cleanOptional(input.displayName) || existing?.displayName || name,
      description: cleanOptional(input.description) ?? existing?.description ?? "",
      activeVersion: version,
      sourceHash,
      parameters,
      versions,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    await writeJsonAtomic(path.join(this.root, id, "template.json"), metadata);
    return publicTemplate(metadata);
  }

  async remove(ref) {
    const template = await this.get(ref);
    await removePath(path.join(this.root, template.id));
    return template;
  }

  async materialize(ref, destination, options = {}) {
    const template = await this.get(ref);
    const version = options.version || template.activeVersion;
    if (!template.versions.some((item) => item.version === version)) throw badRequest(`template version not found: ${version}`);
    const sourceDir = this.versionDirectory(template.id, version);
    if (!await pathExists(sourceDir)) throw new Error(`template source is missing for ${template.slug}@${version}`);
    await ensureDir(destination);
    const files = [];
    for await (const entry of walkFiles(sourceDir)) {
      if (entry.type === "directory") {
        await ensureDir(path.join(destination, normalizeRelativePath(entry.relativePath)));
        continue;
      }
      if (entry.type !== "file") throw badRequest(`unsupported template entry: ${entry.relativePath}`);
      const relativePath = normalizeRelativePath(entry.relativePath);
      const target = path.join(destination, relativePath);
      await ensureDir(path.dirname(target));
      await fs.copyFile(entry.path, target);
      await fs.chmod(target, executableTemplateFile(relativePath) ? 0o700 : 0o600);
      files.push(relativePath);
    }
    return { ...template, activeVersion: version, files };
  }

  versionDirectory(id, version) {
    return path.join(this.root, id, "versions", version);
  }

  async listMetadata() {
    await this.init();
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    const templates = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metadata = await readJson(path.join(this.root, entry.name, "template.json"), null).catch(() => null);
      if (metadata?.id) templates.push(metadata);
    }
    return templates;
  }
}

export function starterSandboxTemplate(options = {}) {
  const baseTemplate = JSON.stringify(String(options.baseTemplate || "kakurizai-base"));
  const cpu = JSON.stringify(String(options.cpu || "2000m"));
  const memory = JSON.stringify(String(options.memory || "2000Mi"));
  const disk = JSON.stringify(String(options.writableLayerSize || "2G"));
  const networkType = JSON.stringify(String(options.networkType || "tap"));
  const allowInternetAccess = options.allowInternetAccess !== false;
  const kubernetesEnabled = options.kubernetesEnabled === true;
  const startupScript = JSON.stringify(String(options.startupScript ?? ""));
  return `terraform {
  required_version = ">= 1.4.0"
}

variable "name" {
  description = "Sandbox name"
  type        = string
}

variable "base_template" {
  description = "CubeSandbox AppSnapshot template"
  type        = string
  default     = ${baseTemplate}
}

variable "cpu" {
  description = "CPU allocation in millicores"
  type        = string
  default     = ${cpu}
}

variable "memory" {
  description = "Memory allocation"
  type        = string
  default     = ${memory}
}

variable "disk_size" {
  description = "Writable root disk size"
  type        = string
  default     = ${disk}
}

variable "startup_script" {
  description = "Runs once after the sandbox is ready"
  type        = string
  default     = ${startupScript}
}

variable "network_type" {
  description = "CubeSandbox network type"
  type        = string
  default     = ${networkType}
}

variable "allow_internet_access" {
  description = "Allow outbound internet access"
  type        = bool
  default     = ${allowInternetAccess}
}

variable "kubernetes_enabled" {
  description = "Install the standalone Kubernetes profile"
  type        = bool
  default     = ${kubernetesEnabled}
}

module "sandbox" {
  source = "./.kakurizai/modules/sandbox"

  name             = var.name
  base_template    = var.base_template
  cpu              = var.cpu
  memory           = var.memory
  disk_size        = var.disk_size
  startup_script   = var.startup_script
  network = {
    type                = var.network_type
    allowInternetAccess = var.allow_internet_access
  }
  host_mounts      = []
  kubernetes       = { enabled = var.kubernetes_enabled }
  labels = {
    "kakurizai.profile"    = "default-sandbox"
    "kakurizai.managed-by" = "terraform-template"
  }
}

output "sandbox_name" {
  value = module.sandbox.name
}
`;
}

export function inspectTerraformVariables(files) {
  const parameters = [];
  const seen = new Set();
  for (const source of files) {
    for (const block of findVariableBlocks(source.text)) {
      if (seen.has(block.name)) throw badRequest(`Terraform variable is declared more than once: ${block.name}`);
      seen.add(block.name);
      const defaultHcl = readTopLevelAttribute(block.body, "default");
      const type = compactHcl(readTopLevelAttribute(block.body, "type") || "any");
      const descriptionValue = parseHclLiteral(readTopLevelAttribute(block.body, "description"));
      const sensitiveValue = parseHclLiteral(readTopLevelAttribute(block.body, "sensitive"));
      parameters.push({
        name: block.name,
        type,
        description: typeof descriptionValue === "string" ? descriptionValue : "",
        required: defaultHcl == null,
        sensitive: sensitiveValue === true,
        default: defaultHcl == null ? undefined : parseHclLiteral(defaultHcl),
        defaultHcl: defaultHcl == null ? null : compactHcl(defaultHcl),
        sourceFile: source.file
      });
    }
  }
  return parameters;
}

export function terraformSandboxRuntimeModule(options = {}) {
  const agctl = JSON.stringify(String(options.agctl || "agctl"));
  return `terraform {
  required_version = ">= 1.4.0"
}

variable "name" {
  type = string
}

variable "base_template" {
  type = string
}

variable "cpu" {
  type = string
}

variable "memory" {
  type = string
}

variable "disk_size" {
  type = string
}

variable "startup_script" {
  type    = string
  default = ""
}

variable "network" {
  type    = any
  default = { type = "tap" }
}

variable "host_mounts" {
  type    = any
  default = []
}

variable "kubernetes" {
  type    = any
  default = { enabled = false }
}

variable "labels" {
  type    = map(string)
  default = {}
}

variable "agctl" {
  type    = string
  default = ${agctl}
}

locals {
  sandbox = {
    name               = var.name
    template           = var.base_template
    cpu                = var.cpu
    memory             = var.memory
    writableLayerSize  = var.disk_size
    startupScript      = var.startup_script
    hostMount          = length(var.host_mounts) > 0
    mounts             = var.host_mounts
    network            = var.network
    kubernetes         = var.kubernetes
    labels             = var.labels
  }
}

resource "terraform_data" "sandbox" {
  input            = merge(local.sandbox, { _agctl = var.agctl })
  triggers_replace = [sha256(jsonencode(local.sandbox))]

  provisioner "local-exec" {
    environment = {
      KAKURIZAI_AGCTL          = self.input._agctl
      KAKURIZAI_TEMPLATE_INPUT = jsonencode(self.input)
    }
    command = <<-EOT
      "$KAKURIZAI_AGCTL" template instantiate --input-env KAKURIZAI_TEMPLATE_INPUT
    EOT
  }

  provisioner "local-exec" {
    when = destroy
    environment = {
      KAKURIZAI_AGCTL = self.input._agctl
      KAKURIZAI_NAME  = self.input.name
    }
    command = <<-EOT
      "$KAKURIZAI_AGCTL" remove "$KAKURIZAI_NAME" --yes
    EOT
  }
}

output "name" {
  value = terraform_data.sandbox.input.name
}
`;
}

export async function instantiateSandboxTemplate(config, input = {}) {
  const name = String(input.name || "").trim();
  if (!name) throw badRequest("template instance name is required");
  const mounts = Array.isArray(input.mounts) ? input.mounts : [];
  const network = input.network && typeof input.network === "object" ? input.network : { type: "tap" };
  const kubernetes = input.kubernetes && typeof input.kubernetes === "object" ? input.kubernetes : { enabled: false };
  const labels = input.labels && typeof input.labels === "object" && !Array.isArray(input.labels) ? input.labels : {};
  const { upsertWorldFromManifest, execWorld } = await import("./worlds.js");
  const result = await upsertWorldFromManifest(config, {
    apiVersion: "kakurizai.dev/v1",
    kind: "Sandbox",
    metadata: { name, labels },
    spec: {
      backend: input.backend || "cube-sandbox-overlay",
      template: input.template || config.cube?.template || null,
      hostMount: {
        enabled: input.hostMount === true || mounts.length > 0,
        path: mounts[0]?.sourcePath || null,
        mode: mounts[0]?.mode || "none",
        mounts
      },
      resources: {
        cpu: input.cpu || config.cube?.cpu || "2000m",
        memory: input.memory || config.cube?.memory || "2000Mi",
        writableLayerSize: input.writableLayerSize || input.diskSize || config.cube?.writableLayerSize || "2G"
      },
      network,
      kubernetes
    }
  });
  const startupScript = String(input.startupScript || "").trim();
  let startup = null;
  if (startupScript) {
    startup = await execWorld(config, result.world.id, ["/bin/sh", "-lc", startupScript]);
    if (typeof startup?.code === "number" && startup.code !== 0) {
      throw new Error(`template startup script exited with ${startup.code}: ${startup.stderr || startup.stdout || "no output"}`);
    }
  }
  return { ...result, startup };
}

function publicTemplate(metadata) {
  return structuredClone(metadata);
}

async function collectDirectoryFiles(directory) {
  const stat = await fs.stat(directory).catch(() => null);
  if (!stat?.isDirectory()) throw badRequest(`template directory not found: ${directory}`);
  const files = new Map();
  let total = 0;
  for await (const entry of walkFiles(directory)) {
    const relativePath = normalizeRelativePath(entry.relativePath);
    if (pathSegments(relativePath).some((segment) => SKIPPED_DIRECTORIES.has(segment))) continue;
    if (entry.type === "directory") continue;
    if (entry.type !== "file") throw badRequest(`template source may not contain ${entry.type}: ${relativePath}`);
    if (skipTemplateFile(relativePath)) continue;
    const stat = await fs.stat(entry.path);
    if (stat.size > MAX_TEMPLATE_FILE_BYTES) throw badRequest(`template file is too large: ${relativePath}`);
    total += stat.size;
    if (total > MAX_TEMPLATE_BYTES) throw badRequest("template source exceeds 16 MiB");
    files.set(relativePath, await fs.readFile(entry.path));
  }
  return files;
}

function collectInlineFiles(input) {
  const files = new Map();
  let total = 0;
  for (const [name, value] of Object.entries(input || {})) {
    const relativePath = normalizeRelativePath(name);
    if (skipTemplateFile(relativePath)) throw badRequest(`template file is not allowed: ${relativePath}`);
    const content = Buffer.from(String(value ?? ""), "utf8");
    if (content.length > MAX_TEMPLATE_FILE_BYTES) throw badRequest(`template file is too large: ${relativePath}`);
    total += content.length;
    if (total > MAX_TEMPLATE_BYTES) throw badRequest("template source exceeds 16 MiB");
    files.set(relativePath, content);
  }
  return files;
}

function findVariableBlocks(text) {
  const blocks = [];
  const pattern = /\bvariable\s+"([A-Za-z_][A-Za-z0-9_-]*)"\s*\{/g;
  for (;;) {
    const match = pattern.exec(text);
    if (!match) break;
    const open = pattern.lastIndex - 1;
    const close = matchingBrace(text, open);
    if (close < 0) throw badRequest(`unterminated Terraform variable block: ${match[1]}`);
    blocks.push({ name: match[1], body: text.slice(open + 1, close) });
    pattern.lastIndex = close + 1;
  }
  return blocks;
}

function matchingBrace(text, open) {
  let depth = 0;
  let quote = false;
  let escape = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (escape) { escape = false; continue; }
      if (char === "\\") { escape = true; continue; }
      if (char === '"') quote = false;
      continue;
    }
    if (char === "#" || (char === "/" && next === "/")) { lineComment = true; if (char === "/") index += 1; continue; }
    if (char === "/" && next === "*") { blockComment = true; index += 1; continue; }
    if (char === '"') { quote = true; continue; }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function readTopLevelAttribute(body, name) {
  const lines = body.split("\n");
  const pattern = new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`);
  for (let index = 0; index < lines.length; index += 1) {
    const match = pattern.exec(lines[index]);
    if (!match) continue;
    let value = match[1];
    const heredoc = /^<<-?([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(value.trim());
    if (heredoc) {
      const content = [];
      for (index += 1; index < lines.length; index += 1) {
        if (lines[index].trim() === heredoc[1]) return JSON.stringify(content.join("\n"));
        content.push(lines[index].replace(/^\s{0,4}/, ""));
      }
      return value;
    }
    let balance = hclBalance(value);
    while ((balance.depth > 0 || balance.quote) && index + 1 < lines.length) {
      value += `\n${lines[++index]}`;
      balance = hclBalance(value);
    }
    return value.trim();
  }
  return null;
}

function hclBalance(value) {
  let depth = 0;
  let quote = false;
  let escape = false;
  for (const char of value) {
    if (quote) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') quote = false;
      continue;
    }
    if (char === '"') quote = true;
    else if ("[{(".includes(char)) depth += 1;
    else if ("]})".includes(char)) depth -= 1;
  }
  return { depth, quote };
}

function parseHclLiteral(value) {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (/^(true|false)$/.test(trimmed)) return trimmed === "true";
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed === "null") return null;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed); } catch { return trimmed.slice(1, -1); }
  }
  try { return JSON.parse(trimmed); } catch { return trimmed; }
}

function compactHcl(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function hashFiles(files) {
  const hash = crypto.createHash("sha256");
  for (const [name, content] of [...files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(name).update("\0").update(content).update("\0");
  }
  return hash.digest("hex");
}

function totalFileBytes(files) {
  return [...files.values()].reduce((total, content) => total + content.length, 0);
}

function dedupeVersions(versions) {
  const byVersion = new Map();
  for (const version of versions) if (!byVersion.has(version.version)) byVersion.set(version.version, version);
  return [...byVersion.values()].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

function normalizeRelativePath(value) {
  const input = String(value || "").replaceAll("\\", "/");
  const normalized = path.posix.normalize(input);
  if (!normalized || normalized === "." || normalized.startsWith("../") || path.posix.isAbsolute(normalized) || normalized.includes("\0")) {
    throw badRequest(`unsafe template path: ${value}`);
  }
  return normalized;
}

function pathSegments(value) {
  return value.split("/").filter(Boolean);
}

function skipTemplateFile(relativePath) {
  const name = path.posix.basename(relativePath);
  return pathSegments(relativePath).some((segment) => SKIPPED_DIRECTORIES.has(segment))
    || /(?:^|\.)tfstate(?:\.|$)/.test(name)
    || name.endsWith(".tfplan")
    || name === "terraform.tfvars"
    || name.endsWith(".auto.tfvars")
    || relativePath.startsWith(".kakurizai/");
}

function isTextTemplateFile(relativePath) {
  const name = path.posix.basename(relativePath);
  return /\.(?:tf|tfvars\.example|json|ya?ml|md|txt|sh|bash|zsh|toml|ini|conf|env\.example)$/i.test(relativePath)
    || ["Dockerfile", "Makefile", ".terraform.lock.hcl"].includes(name);
}

function executableTemplateFile(relativePath) {
  return /\.(?:sh|bash|zsh)$/i.test(relativePath);
}

function cleanTemplateName(value) {
  const name = String(value || "").trim();
  if (!name || name.length > 80) throw badRequest("template name must be between 1 and 80 characters");
  return name;
}

function cleanOptional(value) {
  if (value == null) return null;
  return String(value).trim().slice(0, 500);
}

function isStringType(value) {
  return String(value || "any").replace(/\s+/g, "") === "string";
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}
