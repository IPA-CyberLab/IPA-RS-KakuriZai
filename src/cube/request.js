export function buildCubeSandboxRequest(world, cubeConfig = {}) {
  const workspace = cubeConfig.workspacePath || "/workspace";
  const lower = "/kakurizai/lower";
  const upper = "/kakurizai/upper";
  const work = "/kakurizai/work";
  const whiteouts = "/kakurizai/whiteouts";
  const workspaceArg = shellQuote(workspace);
  const setup = [
    "set -eu",
    `mkdir -p ${workspaceArg} ${lower} ${upper} ${work} ${whiteouts}`,
    `mount -t overlay overlay -o lowerdir=${lower},upperdir=${upper},workdir=${work} ${workspaceArg} || fuse-overlayfs -o lowerdir=${lower},upperdir=${upper},workdir=${work} ${workspaceArg}`,
    "tail -f /dev/null"
  ].join("; ");
  const volumes = [
    emptyDirVolume("tmp", cubeConfig.rootVolumeSize || "1G"),
    hostDirVolume("lower", world.sourcePath),
    hostDirVolume("upper", world.paths.upper),
    hostDirVolume("work", world.paths.workdir),
    hostDirVolume("whiteouts", world.paths.whiteouts)
  ];
  return {
    requestID: `kakurizai-${world.id}`,
    volumes,
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
      "cube.master.appsnapshot.template.id": cubeConfig.template || "kakurizai-base",
      "cube.master.appsnapshot.template.version": cubeConfig.templateVersion || "v2"
    },
    labels: {
      "app.kubernetes.io/managed-by": "kakurizai",
      "kakurizai.world": world.id
    },
    instance_type: cubeConfig.instanceType || "cubebox",
    network_type: cubeConfig.networkType || "tap",
    namespace: cubeConfig.namespace || "kakurizai"
  };
}

function emptyDirVolume(name, sizeLimit) {
  return {
    name,
    volume_source: {
      empty_dir: {
        medium: 0,
        size_limit: sizeLimit
      }
    }
  };
}

function hostDirVolume(name, hostPath) {
  return {
    name,
    volume_source: {
      host_dir_volumes: {
        volume_sources: [
          {
            name,
            host_path: hostPath
          }
        ]
      }
    }
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
