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
| Create K8s Lab | `agctl lab kubernetes --name <name> --control-planes 1 --workers 2` |
| Refresh/list sandboxes | `agctl list` or `agctl list --json` |
| Select/show details | `agctl show <sandbox>` or `agctl show <sandbox> --json` |
| File button | `agctl file <sandbox>` or `agctl open <sandbox> file` |
| Terminal button | `agctl terminal <sandbox>` or `agctl open <sandbox> terminal` |
| VS Code button | `agctl vscode <sandbox>` or `agctl open <sandbox> vscode` |
| Agent button | `agctl agent <sandbox>` or `agctl open <sandbox> agent` |
| Apply button | `agctl apply <sandbox>` |
| Remove button | `agctl remove <sandbox>` with interactive confirmation, or `agctl remove <sandbox> --yes` |

Automation can use `--json` on `list`, `show`, `changed`, `apply`, `lab kubernetes`, and `remove`.

## Authentication

Authentication is provider-based. Configure `auth.provider` in `KAKURIZAI_CONFIG` or `$KAKURIZAI_HOME/config.json`.

- `self`: local HMAC JWT issuer. Use `agctl auth token`.
- `local`: built-in username/password realm with scrypt password hashes and per-user TOTP.
- `auth0`: normalized to OIDC with `domain` and `audience`.
- `cognito`: normalized to OIDC with `region`, `userPoolId`, and `clientId`.
- `oidc`: direct issuer/JWKS configuration.

Studio does not put bearer tokens in the listening URL. Sign in once; the browser receives an HttpOnly `SameSite=Strict` session cookie and mutating API requests require an `X-CSRF-Token` header. Web terminals use the same cookie session instead of `?token=`.

For a Proxmox-style local realm, create a password hash and TOTP secret:

```sh
printf '%s' 'change-this-password' | agctl auth password-hash --stdin
agctl auth totp-secret --subject alice
```

```json
{
  "auth": {
    "provider": "local",
    "users": {
      "alice": {
        "passwordHash": "scrypt$N=16384,r=8,p=1,l=32$...",
        "roles": ["admin"],
        "totp": { "secret": "BASE32SECRET" }
      }
    },
    "rbac": { "enabled": true }
  }
}
```

Self-auth tokens issued by `agctl auth token` carry the `admin` role by default. You can restrict tokens:

```sh
agctl auth token --subject alice --role viewer
agctl auth token --subject ops --role operator --ttl 3600
```

Built-in roles are:

- `viewer`: read-only Studio/world access.
- `operator`: create/update/pause/resume/apply/shell/dev-access.
- `admin`: operator permissions plus delete/admin.

For self-auth TOTP, generate a secret and put it in config:

```sh
agctl auth totp-secret --subject alice
```

```json
{
  "auth": {
    "provider": "self",
    "totp": {
      "enabled": true,
      "users": {
        "alice": { "secret": "BASE32SECRET" }
      }
    }
  }
}
```

For OIDC/Auth0/Cognito, prefer MFA at the identity provider. Set `"mfa": { "required": true }` to require an `amr`/`acr` MFA claim. RBAC can come from token `roles`, `groups`, `scope`, or explicit `auth.rbac.users` bindings.

Studio sessions are persisted in `$KAKURIZAI_HOME/auth/studio-sessions.json` by default. Audit logs are JSONL at `$KAKURIZAI_HOME/audit/studio.jsonl`; write operations are logged by default, reads can be enabled with `"audit": { "logReads": true }`, and audit entries include a hash chain by default.

The default listener is loopback-only. To make Studio reachable from another device:

```sh
agctl studio --host 0.0.0.0
```

Remote exposure is fail-closed. When Studio is bound to `0.0.0.0`, `::`, a LAN IP, or a public IP, startup is refused unless all of these are true:

- authentication is not `none`;
- MFA covers the login provider;
- RBAC, persistent sessions, and audit logging are enabled;
- built-in TLS is configured, or `studio.publicUrl` is HTTPS and `studio.secureCookies` is true;
- the public host is pinned with `studio.publicUrl` or `studio.allowedHosts`.

Use a reverse proxy with HTTPS or configure built-in TLS:

```json
{
  "studio": {
    "host": "0.0.0.0",
    "port": 38476,
    "publicUrl": "https://kakurizai.example.com/",
    "secureCookies": true,
    "trustProxy": true,
    "trustedProxies": ["127.0.0.1"],
    "allowedHosts": ["kakurizai.example.com"],
    "trustedOrigins": ["https://kakurizai.example.com"],
    "ipAllowlist": [],
    "ipDenylist": [],
    "tls": {
      "certFile": "/etc/kakurizai/tls.crt",
      "keyFile": "/etc/kakurizai/tls.key"
    }
  }
}
```

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
- outbound NAT and ingress port-forward definitions
- host VLAN access bridges
- Kubernetes lab profile, cluster name, node role, node name, CIDRs, CNI, join endpoint/token, API server port, node ports, extra args, and editable sysctls

CubeSandbox OSS accepts `network_type=tap`, exposed ports, DNS config, and `cube_network_config` egress policy directly. KakuriZai applies outbound egress controls on the host and, when VLAN is enabled, creates a host VLAN subinterface plus bridge and attaches the sandbox TAP device as an access port.

Studio also includes a network probe action. It builds a sandbox-to-sandbox reachability plan from CubeSandbox runtime IPs, then can execute ICMP/TCP checks from each provisioned sandbox and render reachable, blocked, and unknown paths in the Network view. The same view summarizes K8s labs by cluster, control-plane and worker nodes, API/join endpoints, CIDRs, NodePorts, NAT, and forwards.

For multi-sandbox Kubernetes experiments, use the Studio action menu's `Create K8s Lab` flow to create a batch of control-plane and worker sandboxes with shared TAP egress policy, exposed API/node ports, CNI, pod/service CIDRs, join token, sysctls, and extra kubelet/runtime args. The generated worlds are named from the lab prefix, for example `demo-cp-1` and `demo-worker-1`, and carry `kakurizai.lab` plus `kakurizai.kubernetes.*` annotations and labels for runtime bootstrappers or host-side automation.

You can also compose a lab manually by using the same cluster name across sandboxes and setting each sandbox role to `control-plane`, `worker`, or `standalone`.

## Backends

Default backend selection preserves the IsolatedAgent defaults:

- macOS: `apfs-clone`
- Windows: `windows-block-clone`
- Linux: `linux-native`

`cube-sandbox-overlay` adds strong execution isolation by running commands inside a CubeSandbox sandbox. The host source is mounted read-only as lower, and the sandbox upper/work paths are mounted separately. Inside the sandbox, overlayfs or fuse-overlayfs presents `/workspace`.

## Existing agctl

The local `agctl` wrapper delegates unknown commands, and existing env-oriented `exec`/`shell` calls for unknown sandbox names, to IPA-RS IsolatedAgent `agentctl` when it is installed. If `agentctl` is missing but Cargo exists, it can run the submodule workspace with `cargo run`.
