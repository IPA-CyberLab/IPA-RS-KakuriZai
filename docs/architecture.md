# Architecture

`agctl` is the control plane for named Worlds. A backend owns runtime creation, command execution, shell attachment, pause/resume, and removal. The repository keeps third-party execution systems as submodules:

- IsolatedAgent for existing native desktop and Linux lifecycle behavior.
- CubeSandbox for MicroVM-backed execution.

The KakuriZai layer owns World metadata, Studio API state, and backend-neutral lifecycle routing.

## CubeSandbox

The Cube backend generates a `RunCubeSandboxRequest` with host directory mounts when a workspace is attached:

- lower: original source path, read-only
- upper: per-World writable layer
- workdir: overlayfs workdir
- whiteouts: explicit delete markers

The guest workspace is mounted at `/workspace`. In CubeMaster v2 mode the registered template owns the `cube_rootfs_rw` volume definition; KakuriZai supplies its `/` mount without redefining the volume. `apply` is the only code path that copies upper entries back to the source path or removes whiteout targets.

## gVisor

The gVisor backend verifies that Docker has the configured `runsc` runtime, then launches a labelled container with `--runtime runsc`. For `agctl-overlay` host mounts it copies the source tree into the World upper directory and bind-mounts that copy. `changed` compares file contents, modes, symlink targets, additions, and deletions against the source; `apply` is the only operation that mutates the source.

## Fuchsia

The Fuchsia backend uses an isolated `ffx` directory and a local product bundle. It starts a headless emulator, verifies the target, and can host/register the product-bundle repository. Linux host bind mounts are rejected before runtime creation. Pause uses a persistent emulator stop and resume reuses the staged emulator state.

Authentication is isolated from request handling through `createAuthProvider()`. Provider-specific configuration is normalized before request verification; production deployments use Keycloak or a compatible OIDC provider, while `none` is restricted to isolated local development.
