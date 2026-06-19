# IPA-RS KakuriZai

KakuriZai is a World lifecycle control plane and compact Agent Studio UI for isolated workspaces. It imports IPA-RS IsolatedAgent and Tencent CubeSandbox as Git submodules, then adds a `cube-sandbox-overlay` backend that maps a host source folder to a writable per-World upper layer.

## Submodules

```bash
git submodule update --init --recursive
```

- `vendor/IPA-RS-IsolatedAgent` provides the existing `agentctl`/`agctl` lifecycle implementation and native macOS/Windows/Linux backends.
- `vendor/CubeSandbox` provides the CubeSandbox/Cubelet runtime used by `cube-sandbox-overlay`.

## Quick Start

```bash
npm test
npm run agctl -- create --source /path/to/source --name demo --backend cube-sandbox-overlay
npm run agctl -- list
npm start
```

When `cubecli` is not installed, Cube Worlds are still recorded with their metadata, upper/work/whiteout/log paths, and generated Cube request. Their sandbox status is `planned` until CubeSandbox is available.

## Authentication

Authentication is provider-based. Configure `auth.provider` in `KAKURIZAI_CONFIG` or `$KAKURIZAI_HOME/config.json`.

- `self`: local HMAC JWT issuer. Use `agctl auth token`.
- `auth0`: normalized to OIDC with `domain` and `audience`.
- `cognito`: normalized to OIDC with `region`, `userPoolId`, and `clientId`.
- `oidc`: direct issuer/JWKS configuration.

Examples live in `config/auth0.example.json` and `config/cognito.example.json`.

## World Model

Each World stores:

- source path
- backend name
- upper layer path
- overlay workdir
- whiteout path
- logs and exports
- sandbox/base IDs
- session list
- apply/export state

Writes are represented in the upper layer or whiteout tree. Host source files are changed only by `agctl apply <world>`.

## Backends

Default backend selection preserves the IsolatedAgent defaults:

- macOS: `apfs-clone`
- Windows: `windows-block-clone`
- Linux: `linux-native`

`cube-sandbox-overlay` adds strong execution isolation by running commands inside CubeSandbox. The host source is mounted read-only as lower, and the World upper/work paths are mounted separately. Inside the sandbox, overlayfs or fuse-overlayfs presents `/workspace`.

## Existing agctl

The local `agctl` wrapper delegates unknown commands, and existing env-oriented `exec`/`shell` calls for unknown World names, to IPA-RS IsolatedAgent `agentctl` when it is installed. If `agentctl` is missing but Cargo exists, it can run the submodule workspace with `cargo run`.
