import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { SandboxTemplateStore, starterSandboxTemplate } from "../dist/src/core/templates.js";
import { TerraformManager } from "../dist/src/core/terraform.js";

const execFileAsync = promisify(execFile);

test("Terraform sandbox templates are versioned and expose standard variables", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-templates-"));
  const source = path.join(tmp, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "main.tf"), starterSandboxTemplate({ baseTemplate: "tpl-base" }), "utf8");
  const store = new SandboxTemplateStore({ storeDir: path.join(tmp, "store") });

  const first = await store.push({
    name: "dev-tools",
    displayName: "Developer tools",
    description: "Reusable development sandbox",
    directory: source
  });
  assert.equal(first.slug, "dev-tools");
  assert.equal(first.parameters.find((item) => item.name === "name").required, true);
  assert.equal(first.parameters.find((item) => item.name === "base_template").default, "tpl-base");
  assert.equal(first.versions.length, 1);

  await fs.appendFile(path.join(source, "main.tf"), "\noutput \"revision\" { value = 2 }\n", "utf8");
  const second = await store.push({ name: "dev-tools", directory: source });
  assert.equal(second.id, first.id);
  assert.notEqual(second.activeVersion, first.activeVersion);
  assert.equal(second.versions.length, 2);
  assert.match((await store.getWithSource("dev-tools")).files["main.tf"], /revision/);

  await assert.rejects(
    () => store.push({ name: "invalid", files: { "main.tf": "terraform {}\n" } }),
    /variable "name"/
  );
  await assert.rejects(
    () => store.push({ name: "escape", files: { "../main.tf": "" } }),
    /unsafe template path/
  );

  const portable = await store.push({
    name: "portable-example",
    directory: path.resolve("templates/developer-sandbox")
  });
  assert.equal(portable.parameters.find((item) => item.name === "base_template").default, "");
});

test("CLI initializes and pushes a Coder-style Terraform template directory", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-template-cli-"));
  const home = path.join(tmp, "home");
  const source = path.join(tmp, "template");
  const environment = {
    ...process.env,
    KAKURIZAI_CONFIG: "",
    KAKURIZAI_HOME: home,
    KAKURIZAI_CUBE_MODE: "disabled"
  };
  await execFileAsync(process.execPath, ["./dist/bin/agctl.js", "templates", "init", "--directory", source], {
    cwd: process.cwd(),
    env: environment
  });
  const pushed = await execFileAsync(process.execPath, ["./dist/bin/agctl.js", "templates", "push", "dev-tools", "--directory", source, "--json"], {
    cwd: process.cwd(),
    env: environment
  });
  assert.equal(JSON.parse(pushed.stdout).slug, "dev-tools");
  const listed = await execFileAsync(process.execPath, ["./dist/bin/agctl.js", "templates", "list", "--json"], {
    cwd: process.cwd(),
    env: environment
  });
  assert.equal(JSON.parse(listed.stdout)[0].parameters.some((item) => item.name === "startup_script"), true);

  const instantiated = await execFileAsync(process.execPath, ["./dist/bin/agctl.js", "template", "instantiate", "--input-env", "KAKURIZAI_TEMPLATE_INPUT", "--json"], {
    cwd: process.cwd(),
    env: {
      ...environment,
      KAKURIZAI_TEMPLATE_INPUT: JSON.stringify({
        name: "template-created",
        template: "tpl-base",
        cpu: "3000m",
        memory: "3Gi",
        writableLayerSize: "4G",
        network: { type: "tap" },
        labels: { "kakurizai.managed-by": "terraform-template" }
      })
    }
  });
  const instance = JSON.parse(instantiated.stdout);
  assert.equal(instance.action, "created");
  assert.equal(instance.world.backendConfig.template, "tpl-base");
  assert.equal(instance.world.backendConfig.cpu, "3000m");
  assert.equal(instance.world.labels["kakurizai.managed-by"], "terraform-template");
});

test("Terraform manager materializes and runs a template as an isolated instance project", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-template-deploy-"));
  const binary = path.join(tmp, "terraform-bin");
  await fs.writeFile(binary, `#!/bin/sh
set -eu
case "$1" in
  version) printf '%s\n' '{"terraform_version":"1.15.5","platform":"linux_amd64"}' ;;
  init) mkdir -p .terraform; : > .terraform.lock.hcl ;;
  validate) test -f .kakurizai/modules/sandbox/main.tf ;;
  plan) printf '%s\n' 'template plan' > terraform.tfplan; exit 2 ;;
  show) test -f terraform.tfplan; printf '%s\n' 'one sandbox to add' ;;
  apply) test -f terraform.tfplan; printf '%s\n' '{"version":4}' > terraform.tfstate ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
  const config = {
    home: path.join(tmp, "home"),
    storeDir: path.join(tmp, "store"),
    configPath: path.join(tmp, "config.json"),
    terraform: { binary, workDir: path.join(tmp, "terraform"), commandTimeoutSeconds: 10 },
    cube: { mode: "disabled" }
  };
  const source = path.join(tmp, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "main.tf"), starterSandboxTemplate(), "utf8");
  const store = new SandboxTemplateStore(config);
  const template = await store.push({ name: "developer", directory: source });
  const manager = new TerraformManager(config);
  await manager.load();
  try {
    await assert.rejects(
      () => manager.startTemplateDeployment(store, template, { name: "bad", variables: { missing: "value" } }),
      /unknown template variable/
    );
    const started = await manager.startTemplateDeployment(store, template, {
      name: "terraform-lab",
      variables: { cpu: "4000m", memory: "4Gi" }
    }, { subject: "alice" });
    assert.equal(started.action, "deploy");
    const completed = await waitForRun(manager, started.id);
    assert.equal(completed.status, "succeeded");
    assert.match(completed.log, /one sandbox to add/);
    const overview = await manager.overview([]);
    const project = overview.projects.find((item) => item.projectKind === "template-instance");
    assert.equal(project.templateId, template.id);
    assert.equal(project.instanceName, "terraform-lab");
    assert.equal(project.statePresent, true);
    const projectDir = path.join(config.terraform.workDir, "projects", project.projectId);
    const variables = JSON.parse(await fs.readFile(path.join(projectDir, "terraform.auto.tfvars.json"), "utf8"));
    assert.deepEqual(variables, { name: "terraform-lab", cpu: "4000m", memory: "4Gi" });
    assert.match(await fs.readFile(path.join(projectDir, ".kakurizai/modules/sandbox/main.tf"), "utf8"), /template instantiate/);

    const staleMetadata = JSON.parse(await fs.readFile(path.join(projectDir, "project.json"), "utf8"));
    staleMetadata.statePresent = false;
    await fs.writeFile(path.join(projectDir, "project.json"), JSON.stringify(staleMetadata), "utf8");
    const alternative = await store.push({ name: "developer-alternative", directory: source });
    await assert.rejects(
      () => manager.startTemplateDeployment(store, alternative, { name: "terraform-lab" }),
      /already managed by template/
    );
  } finally {
    await manager.close();
  }
});

async function waitForRun(manager, id) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await manager.getRun(id);
    if (!["queued", "running", "canceling"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for Terraform run ${id}`);
}
