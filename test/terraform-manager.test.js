import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TerraformManager } from "../dist/src/core/terraform.js";

test("Terraform manager retains plans and state and refuses stale or unconfirmed apply", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-terraform-manager-"));
  const binary = path.join(tmp, "terraform");
  await fs.writeFile(binary, `#!/bin/sh
set -eu
command="$1"
case "$command" in
  version)
    printf '%s\n' '{"terraform_version":"1.15.5","platform":"linux_amd64","provider_selections":{}}'
    ;;
  init)
    mkdir -p .terraform
    : > .terraform.lock.hcl
    printf '%s\n' 'Terraform has been successfully initialized!'
    ;;
  validate)
    printf '%s\n' 'Success! The configuration is valid.'
    ;;
  plan)
    printf '%s\n' 'fake plan' > terraform.tfplan
    printf '%s\n' 'Plan: 1 to add, 0 to change, 0 to destroy.'
    exit 2
    ;;
  show)
    test -f terraform.tfplan
    printf '%s\n' '# reviewed fake plan'
    ;;
  apply)
    test -f terraform.tfplan
    printf '%s\n' '{"version":4}' > terraform.tfstate
    printf '%s\n' 'Apply complete! Resources: 1 added.'
    ;;
  *)
    printf '%s\n' "unexpected command: $command" >&2
    exit 1
    ;;
esac
`, { mode: 0o700 });

  const config = {
    home: path.join(tmp, "home"),
    configPath: path.join(tmp, "home", "config.json"),
    terraform: {
      binary,
      workDir: path.join(tmp, "home", "terraform"),
      commandTimeoutSeconds: 10
    }
  };
  const world = {
    id: "world-123",
    name: "terraform-lab",
    backend: "cube-sandbox-overlay",
    sourcePath: "",
    labels: {},
    backendConfig: {
      hostMount: false,
      mountMode: "none",
      cpu: "2000m",
      memory: "2000Mi",
      writableLayerSize: "1G",
      network: { type: "tap" }
    }
  };

  const manager = new TerraformManager(config);
  await manager.load();
  try {
    const availability = await manager.availability();
    assert.equal(availability.installed, true);
    assert.equal(availability.version, "1.15.5");

    const originalAvailability = manager.availability.bind(manager);
    let releaseAvailability;
    manager.availability = () => new Promise((resolve) => {
      releaseAvailability = () => resolve(availability);
    });
    const reservedRun = manager.startRun(world, "validate", { subject: "alice" });
    await assert.rejects(() => manager.startRun(world, "validate", { subject: "bob" }), /already active/);
    releaseAvailability();
    const validate = await reservedRun;
    manager.availability = originalAvailability;
    assert.equal((await waitForRun(manager, validate.id)).status, "succeeded");

    await assert.rejects(() => manager.startRun(world, "apply"), /run a Terraform plan first/);

    const plan = await manager.startRun(world, "plan", { subject: "alice" });
    const completedPlan = await waitForRun(manager, plan.id);
    assert.equal(completedPlan.status, "succeeded");
    assert.match(completedPlan.log, /Plan: 1 to add/);
    let overview = await manager.overview([world]);
    assert.equal(overview.projects[0].plan.kind, "apply");
    assert.equal(overview.projects[0].plan.hasChanges, true);
    assert.equal(overview.projects[0].lockPresent, true);

    const changedWorld = structuredClone(world);
    changedWorld.backendConfig.cpu = "4000m";
    await assert.rejects(() => manager.startRun(changedWorld, "apply"), /definition changed/);

    const apply = await manager.startRun(world, "apply", { subject: "alice" });
    const completedApply = await waitForRun(manager, apply.id);
    assert.equal(completedApply.status, "succeeded");
    overview = await manager.overview([world]);
    assert.equal(overview.projects[0].statePresent, true);
    assert.equal(overview.projects[0].plan, null);

    await assert.rejects(() => manager.startRun(world, "destroy", { confirmation: "wrong" }), /exactly match/);
    const destroyPlan = await manager.startRun(world, "destroy-plan", { subject: "alice" });
    assert.equal((await waitForRun(manager, destroyPlan.id)).status, "succeeded");
    const destroy = await manager.startRun(world, "destroy", { subject: "alice", confirmation: world.name });
    assert.equal((await waitForRun(manager, destroy.id)).status, "succeeded");
  } finally {
    await manager.close();
  }
});

test("Terraform manager honors the integration disable switch", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-terraform-disabled-"));
  const manager = new TerraformManager({
    home: tmp,
    terraform: { enabled: false, workDir: path.join(tmp, "terraform") }
  });
  await manager.load();
  const availability = await manager.availability();
  assert.equal(availability.enabled, false);
  assert.equal(availability.installed, false);
  await assert.rejects(() => manager.startRun({ id: "disabled", name: "disabled" }, "validate"), /disabled/);
});

async function waitForRun(manager, id) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await manager.getRun(id);
    if (!["queued", "running", "canceling"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for Terraform run ${id}`);
}
