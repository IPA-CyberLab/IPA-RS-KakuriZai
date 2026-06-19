export function buildCubeSandboxRequest(world, cubeConfig = {}) {
  const workspace = cubeConfig.workspacePath || "/workspace";
  const lower = "/kakurizai/lower";
  const upper = "/kakurizai/upper";
  const work = "/kakurizai/work";
  const whiteouts = "/kakurizai/whiteouts";
  const setup = [
    "set -eu",
    `mkdir -p ${workspace} ${lower} ${upper} ${work} ${whiteouts}`,
    `mount -t overlay overlay -o lowerdir=${lower},upperdir=${upper},workdir=${work} ${workspace} || fuse-overlayfs -o lowerdir=${lower},upperdir=${upper},workdir=${work} ${workspace}`,
    "tail -f /dev/null"
  ].join("; ");
  const volumeSources = [
    { name: "lower", host_path: world.sourcePath },
    { name: "upper", host_path: world.paths.upper },
    { name: "work", host_path: world.paths.workdir },
    { name: "whiteouts", host_path: world.paths.whiteouts }
  ];
  return {
    requestID: `kakurizai-${world.id}`,
    volumes: [
      {
        name: "kakurizai-host",
        volume_source: {
          host_dir_volumes: {
            volume_sources: volumeSources
          }
        }
      }
    ],
    containers: [
      {
        name: "workspace",
        image: cubeConfig.image ? { image: cubeConfig.image } : undefined,
        command: ["/bin/sh", "-lc"],
        args: [setup],
        working_dir: workspace,
        volume_mounts: [
          { name: "lower", container_path: lower, readonly: true, host_path: world.sourcePath },
          { name: "upper", container_path: upper, readonly: false, host_path: world.paths.upper },
          { name: "work", container_path: work, readonly: false, host_path: world.paths.workdir },
          { name: "whiteouts", container_path: whiteouts, readonly: false, host_path: world.paths.whiteouts }
        ],
        annotations: {
          "kakurizai.workspace": workspace,
          "kakurizai.world": world.id
        }
      }
    ],
    annotations: {
      "kakurizai.backend": "cube-sandbox-overlay",
      "kakurizai.world": world.id,
      "kakurizai.source": world.sourcePath,
      "kakurizai.upper": world.paths.upper,
      "kakurizai.workspace": workspace,
      "cube.master.appsnapshot.template.id": cubeConfig.template || "kakurizai-base"
    },
    labels: {
      "app.kubernetes.io/managed-by": "kakurizai",
      "kakurizai.world": world.id
    },
    network_type: cubeConfig.networkType || "tap",
    namespace: cubeConfig.namespace || "kakurizai"
  };
}
