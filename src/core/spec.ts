// @ts-nocheck
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { ensureDir } from "./fs.js";
import { normalizeKubernetesConfig, normalizeNetworkConfig } from "./network.js";

export async function readSandboxManifest(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return parseSandboxManifest(text, filePath);
}

export function parseSandboxManifest(text, source = "manifest") {
  const data = source.endsWith(".json") ? JSON.parse(text) : YAML.parse(text);
  if (!data || typeof data !== "object") throw new Error(`${source} is empty`);
  return normalizeSandboxManifest(data);
}

export function normalizeSandboxManifest(data) {
  const spec = data.spec || data;
  const metadata = data.metadata || {};
  const name = metadata.name || spec.name;
  if (!name) throw new Error("manifest metadata.name is required");
  const hostMount = normalizeHostMount(spec);
  const resources = spec.resources || {};
  return {
    apiVersion: data.apiVersion || "kakurizai.dev/v1",
    kind: data.kind || "Sandbox",
    metadata: {
      name,
      labels: metadata.labels || {}
    },
    spec: {
      backend: spec.backend || "cube-sandbox-overlay",
      template: spec.template || null,
      hostMount,
      resources: {
        cpu: resources.cpu || spec.cpu || "2000m",
        memory: resources.memory || spec.memory || "2000Mi",
        writableLayerSize: resources.writableLayerSize || resources.disk || spec.writableLayerSize || "1G"
      },
      network: normalizeNetworkConfig(spec.network || { type: spec.networkType }),
      kubernetes: normalizeKubernetesConfig(spec.kubernetes || spec.k8s || {})
    }
  };
}

export function manifestToCreateInput(manifest) {
  const normalized = normalizeSandboxManifest(manifest);
  const spec = normalized.spec;
  return {
    name: normalized.metadata.name,
    backend: spec.backend,
    sourcePath: spec.hostMount.enabled ? spec.hostMount.path : undefined,
    hostMount: spec.hostMount.enabled,
    mountMode: spec.hostMount.enabled ? spec.hostMount.mode : "none",
    template: spec.template,
    cpu: spec.resources.cpu,
    memory: spec.resources.memory,
    writableLayerSize: spec.resources.writableLayerSize,
    networkType: spec.network.type,
    network: spec.network,
    kubernetes: spec.kubernetes,
    labels: normalized.metadata.labels
  };
}

export function worldToManifest(world) {
  const backendConfig = world.backendConfig || {};
  const hostMount = backendConfig.hostMount !== false && backendConfig.mountMode !== "none";
  return normalizeSandboxManifest({
    apiVersion: "kakurizai.dev/v1",
    kind: "Sandbox",
    metadata: {
      name: world.name,
      labels: world.labels || {}
    },
    spec: {
      backend: world.backend || "cube-sandbox-overlay",
      template: backendConfig.template || null,
      hostMount: {
        enabled: hostMount,
        path: hostMount ? world.sourcePath : null,
        mode: hostMount ? backendConfig.mountMode || world.sandbox?.mountMode || "agctl-overlay" : "none"
      },
      resources: {
        cpu: backendConfig.cpu || "2000m",
        memory: backendConfig.memory || "2000Mi",
        writableLayerSize: backendConfig.writableLayerSize || "1G"
      },
      network: backendConfig.network || { type: backendConfig.networkType || "tap" },
      kubernetes: backendConfig.kubernetes || { enabled: false, profile: "k3s" }
    }
  });
}

export function stringifySandboxManifest(manifest) {
  return YAML.stringify(normalizeSandboxManifest(manifest), { lineWidth: 0 });
}

export async function writeTerraformBundle(manifest, outDir, options = {}) {
  const normalized = normalizeSandboxManifest(manifest);
  const specFile = options.specFile || "sandbox.yaml";
  await ensureDir(outDir);
  await fs.writeFile(path.join(outDir, specFile), stringifySandboxManifest(normalized), "utf8");
  await fs.writeFile(path.join(outDir, "main.tf"), terraformForManifest(normalized, specFile), "utf8");
  await fs.writeFile(path.join(outDir, "README.md"), terraformReadme(normalized), "utf8");
  return {
    outDir,
    files: [path.join(outDir, specFile), path.join(outDir, "main.tf"), path.join(outDir, "README.md")]
  };
}

export function terraformForManifest(manifest, specFile = "sandbox.yaml") {
  const normalized = normalizeSandboxManifest(manifest);
  const name = hclString(normalized.metadata.name);
  const file = hclString(specFile);
  return `terraform {
  required_version = ">= 1.4.0"
}

variable "agctl" {
  type    = string
  default = "agctl"
}

resource "terraform_data" "sandbox" {
  input = {
    name      = ${name}
    agctl     = var.agctl
    spec_file = ${file}
    spec_hash = filesha256("\${path.module}/${specFile}")
  }

  provisioner "local-exec" {
    command = "\${self.input.agctl} apply -f \${path.module}/\${self.input.spec_file}"
  }

  provisioner "local-exec" {
    when    = destroy
    command = "\${self.input.agctl} remove \${self.input.name} --yes || true"
  }
}

output "sandbox_name" {
  value = terraform_data.sandbox.input.name
}
`;
}

function normalizeHostMount(spec) {
  const hostMount = spec.hostMount;
  if (hostMount === false) return { enabled: false, path: null, mode: "none" };
  if (hostMount && typeof hostMount === "object") {
    const enabled = hostMount.enabled !== false && Boolean(hostMount.path || spec.sourcePath || spec.source);
    return {
      enabled,
      path: enabled ? hostMount.path || spec.sourcePath || spec.source : null,
      mode: enabled ? hostMount.mode || spec.mountMode || "agctl-overlay" : "none"
    };
  }
  const pathValue = spec.sourcePath || spec.source;
  return {
    enabled: Boolean(pathValue),
    path: pathValue || null,
    mode: pathValue ? spec.mountMode || "agctl-overlay" : "none"
  };
}

function terraformReadme(manifest) {
  return `# KakuriZai Sandbox

This Terraform bundle manages the ${manifest.metadata.name} Sandbox through agctl.

\`\`\`sh
terraform init
terraform apply
terraform destroy
\`\`\`
`;
}

function hclString(value) {
  return JSON.stringify(String(value));
}
