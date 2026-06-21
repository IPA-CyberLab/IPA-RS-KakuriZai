# IPA-RS KakuriZai

KakuriZai is a sandbox lifecycle control plane and compact Studio UI for isolated workspaces. CubeSandbox is the sandbox runtime. KakuriZai adds a `cube-sandbox-overlay` runtime path that maps a host source folder to a writable per-sandbox upper layer.

## Submodules

```bash
git submodule update --init --recursive
```

- `vendor/IPA-RS-IsolatedAgent` provides the existing `agentctl`/`agctl` lifecycle implementation and native macOS/Windows/Linux backends.
- `vendor/CubeSandbox` provides the sandbox runtime used by `cube-sandbox-overlay`.

## Quick Start

```bash
npm test
npm run agctl -- create --source /path/to/source --name demo --backend cube-sandbox-overlay
npm run agctl -- list
npm start
```

When `cubecli` is not installed, sandboxes are still recorded with their metadata, upper/work/whiteout/log paths, and generated Cube request. Their runtime status is `planned` until CubeSandbox is available.

## CLI And Studio Parity

Every Studio operation has a CLI equivalent:

| Studio operation | CLI |
| --- | --- |
| Create sandbox | `agctl create --source <folder> --name <name> --backend cube-sandbox-overlay` |
| Refresh/list sandboxes | `agctl list` or `agctl list --json` |
| Select/show details | `agctl show <sandbox>` or `agctl show <sandbox> --json` |
| File button | `agctl file <sandbox>` or `agctl open <sandbox> file` |
| Terminal button | `agctl terminal <sandbox>` or `agctl open <sandbox> terminal` |
| VS Code button | `agctl vscode <sandbox>` or `agctl open <sandbox> vscode` |
| Agent button | `agctl agent <sandbox>` or `agctl open <sandbox> agent` |
| Apply button | `agctl apply <sandbox>` |
| Remove button | `agctl remove <sandbox>` with interactive confirmation, or `agctl remove <sandbox> --yes` |

Automation can use `--json` on `list`, `show`, `changed`, `apply`, and `remove`.

## Authentication

Authentication is provider-based. Configure `auth.provider` in `KAKURIZAI_CONFIG` or `$KAKURIZAI_HOME/config.json`.

- `self`: local HMAC JWT issuer. Use `agctl auth token`.
- `auth0`: normalized to OIDC with `domain` and `audience`.
- `cognito`: normalized to OIDC with `region`, `userPoolId`, and `clientId`.
- `oidc`: direct issuer/JWKS configuration.

Examples live in `config/auth0.example.json` and `config/cognito.example.json`.

## Sandbox Model

Each sandbox stores:

- source path
- runtime name
- upper layer path
- overlay workdir
- whiteout path
- logs and exports
- sandbox runtime/base IDs
- session list
- apply/export state

Writes are represented in the upper layer or whiteout tree. Host source files are changed only by `agctl apply <sandbox>`.

## TAP Networking

Studio can create and edit the TAP network settings stored on each sandbox:

- exposed ports
- DNS servers, search domains, and resolver options
- internet egress, allow/deny CIDRs, and L7 egress rules
- NAT metadata, masquerade mode, outbound interface, subnet/gateway, and port-forward definitions
- VLAN metadata for host-side bridge integrations
- Kubernetes lab profile, cluster name, node role, node name, CIDRs, CNI, join endpoint/token, API server port, node ports, extra args, and required sysctls

CubeSandbox OSS accepts `network_type=tap`, exposed ports, DNS config, and `cube_network_config` egress policy directly. NAT and VLAN bridge settings are persisted as KakuriZai annotations so host-side integrations or future CubeSandbox plugins can consume them.

Studio also includes a network probe action. It builds a sandbox-to-sandbox reachability plan from CubeSandbox runtime IPs, then can execute ICMP/TCP checks from each provisioned sandbox and render reachable, blocked, and unknown paths in the Network view.

For multi-sandbox Kubernetes experiments, use the same cluster name across sandboxes and set each sandbox role to `control-plane`, `worker`, or `standalone`. The generated Cube request carries this lab metadata as `kakurizai.kubernetes.*` annotations and labels for runtime bootstrappers or host-side automation.

## Backends

Default backend selection preserves the IsolatedAgent defaults:

- macOS: `apfs-clone`
- Windows: `windows-block-clone`
- Linux: `linux-native`

`cube-sandbox-overlay` adds strong execution isolation by running commands inside a CubeSandbox sandbox. The host source is mounted read-only as lower, and the sandbox upper/work paths are mounted separately. Inside the sandbox, overlayfs or fuse-overlayfs presents `/workspace`.

## Existing agctl

The local `agctl` wrapper delegates unknown commands, and existing env-oriented `exec`/`shell` calls for unknown sandbox names, to IPA-RS IsolatedAgent `agentctl` when it is installed. If `agentctl` is missing but Cargo exists, it can run the submodule workspace with `cargo run`.
