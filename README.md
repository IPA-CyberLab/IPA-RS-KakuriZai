# IPA-RS KakuriZai

KakuriZai is a VM lifecycle control plane and compact Studio UI for isolated workspaces. CubeSandbox is treated as the VM runtime: each launched CubeSandbox instance is exposed to users as a VM. KakuriZai adds a `cube-sandbox-overlay` runtime path that maps a host source folder to a writable per-VM upper layer.

## Submodules

```bash
git submodule update --init --recursive
```

- `vendor/IPA-RS-IsolatedAgent` provides the existing `agentctl`/`agctl` lifecycle implementation and native macOS/Windows/Linux backends.
- `vendor/CubeSandbox` provides the VM runtime used by `cube-sandbox-overlay`.

## Quick Start

```bash
npm test
npm run agctl -- create --source /path/to/source --name demo --backend cube-sandbox-overlay
npm run agctl -- list
npm start
```

When `cubecli` is not installed, VMs are still recorded with their metadata, upper/work/whiteout/log paths, and generated Cube request. Their runtime status is `planned` until CubeSandbox is available.

## CLI And Studio Parity

Every Studio operation has a CLI equivalent:

| Studio operation | CLI |
| --- | --- |
| Create VM | `agctl create --source <folder> --name <name> --backend cube-sandbox-overlay` |
| Refresh/list VMs | `agctl list` or `agctl list --json` |
| Select/show details | `agctl show <vm>` or `agctl show <vm> --json` |
| File button | `agctl file <vm>` or `agctl open <vm> file` |
| Terminal button | `agctl terminal <vm>` or `agctl open <vm> terminal` |
| VS Code button | `agctl vscode <vm>` or `agctl open <vm> vscode` |
| Agent button | `agctl agent <vm>` or `agctl open <vm> agent` |
| Apply button | `agctl apply <vm>` |
| Remove button | `agctl remove <vm>` with interactive confirmation, or `agctl remove <vm> --yes` |

Automation can use `--json` on `list`, `show`, `changed`, `apply`, and `remove`.

## Authentication

Authentication is provider-based. Configure `auth.provider` in `KAKURIZAI_CONFIG` or `$KAKURIZAI_HOME/config.json`.

- `self`: local HMAC JWT issuer. Use `agctl auth token`.
- `auth0`: normalized to OIDC with `domain` and `audience`.
- `cognito`: normalized to OIDC with `region`, `userPoolId`, and `clientId`.
- `oidc`: direct issuer/JWKS configuration.

Examples live in `config/auth0.example.json` and `config/cognito.example.json`.

## VM Model

Each VM stores:

- source path
- runtime name
- upper layer path
- overlay workdir
- whiteout path
- logs and exports
- VM runtime/base IDs
- session list
- apply/export state

Writes are represented in the upper layer or whiteout tree. Host source files are changed only by `agctl apply <vm>`.

## Backends

Default backend selection preserves the IsolatedAgent defaults:

- macOS: `apfs-clone`
- Windows: `windows-block-clone`
- Linux: `linux-native`

`cube-sandbox-overlay` adds strong execution isolation by running commands inside a CubeSandbox VM. The host source is mounted read-only as lower, and the VM upper/work paths are mounted separately. Inside the VM, overlayfs or fuse-overlayfs presents `/workspace`.

## Existing agctl

The local `agctl` wrapper delegates unknown commands, and existing env-oriented `exec`/`shell` calls for unknown VM names, to IPA-RS IsolatedAgent `agentctl` when it is installed. If `agentctl` is missing but Cargo exists, it can run the submodule workspace with `cargo run`.
