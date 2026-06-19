# Architecture

`agctl` is the control plane for named Worlds. The repository keeps third-party execution systems as submodules:

- IsolatedAgent for existing native desktop and Linux lifecycle behavior.
- CubeSandbox for MicroVM-backed execution.

The Kakurizai layer owns World metadata and Studio API state. The Cube backend generates a `RunCubeSandboxRequest` with four host directory mounts:

- lower: original source path, read-only
- upper: per-World writable layer
- workdir: overlayfs workdir
- whiteouts: explicit delete markers

The guest workspace is mounted at `/workspace`. `apply` is the only code path that copies upper entries back to the source path or removes whiteout targets.

Authentication is isolated from request handling through `createAuthProvider()`. Provider-specific configuration is normalized before request verification, so Auth0, Cognito, custom OIDC, and local self-signed tokens all expose the same subject/claims shape to the API.
