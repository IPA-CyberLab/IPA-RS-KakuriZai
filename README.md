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
| Prepare Terraform source | `agctl terraform export <sandbox> --out ./terraform` |
| Terraform plan/apply/destroy | `terraform plan`, `terraform apply`, and `terraform destroy` in the exported directory |

Automation can use `--json` on `list`, `show`, `changed`, `apply`, `lab kubernetes`, and `remove`.

## Authentication

Authentication is provider-based. Configure `auth.provider` in `KAKURIZAI_CONFIG` or `$KAKURIZAI_HOME/config.json`.

- `keycloak`: the supported production provider. KakuriZai uses Keycloak as an OpenID Connect relying party.
- `oidc`: direct OpenID Connect issuer/JWKS configuration for compatibility.
- `none`: disabled authentication for isolated local development only.

Studio does not put bearer tokens in the listening URL. Sign in once; the browser receives an HttpOnly `SameSite=Strict` session cookie and mutating API requests require an `X-CSRF-Token` header. Web terminals use the same cookie session instead of `?token=`.

KakuriZai does not keep a local password database or TOTP seed store. Users, passwords, MFA, password policy, recovery, and identity lifecycle belong in Keycloak.

```json
{
  "auth": {
    "provider": "keycloak",
    "serverUrl": "https://keycloak.example.com",
    "realm": "kakurizai",
    "clientId": "kakurizai-studio",
    "clientSecret": "replace-with-confidential-client-secret",
    "audience": "kakurizai-studio",
    "authorizationParams": {
      "acr_values": "mfa"
    },
    "mfa": {
      "required": true
    },
    "rbac": {
      "enabled": true,
      "defaultRole": "viewer",
      "roles": {
        "kakurizai-admin": ["admin"],
        "kakurizai-operator": ["operator"],
        "kakurizai-viewer": ["viewer"]
      }
    }
  }
}
```

In Keycloak, create a confidential client with `Standard flow` enabled and set the valid redirect URI to:

```text
https://studio.example.com/api/auth/callback
```

Enable Keycloak MFA for the realm or required user groups, then keep `"mfa": { "required": true }` so KakuriZai rejects sessions without an `amr`/`acr` MFA claim. RBAC can come from Keycloak realm roles, client roles, groups, scope, or explicit `auth.rbac.users` bindings.

For Keycloak, map `mfa` to the desired ACR/LoA level and add the AMR protocol mapper to the Studio client. KakuriZai can request that level with `authorizationParams.acr_values` or `KAKURIZAI_KEYCLOAK_ACR_VALUES`.

Built-in KakuriZai roles are:

- `viewer`: read-only Studio, world, and Terraform access.
- `operator`: create/update/pause/resume/apply/shell/dev-access plus Terraform plan/apply.
- `admin`: operator permissions plus sandbox deletion and account/role management.

Studio's Accounts view separates identity from application authorization: Keycloak remains the source of login identity, while KakuriZai stores editable display fields, local role assignments, suspension state, and browser-session metadata in `$KAKURIZAI_HOME/auth/accounts.json`. Administrators can inspect effective roles, assign `viewer`/`operator`/`admin`, suspend other accounts, and users can revoke their own sessions. Studio sessions remain in `$KAKURIZAI_HOME/auth/studio-sessions.json`; the UI only receives one-way-derived session IDs, never the cookie token itself.

Audit logs are JSONL at `$KAKURIZAI_HOME/audit/studio.jsonl`; write operations are logged by default, reads can be enabled with `"audit": { "logReads": true }`, and audit entries include a hash chain by default.

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

An example lives in `config/keycloak.example.json`.

## Managed Terraform Runs

Studio's Terraform view turns each saved sandbox definition into an isolated Terraform working directory. It retains `terraform.tfstate`, `terraform.tfplan`, `.terraform.lock.hcl`, and bounded run logs under `$KAKURIZAI_HOME/terraform`, and executes the same explicit stages used by a normal Terraform workflow:

1. `terraform init`
2. `terraform validate`
3. `terraform plan -out=terraform.tfplan`
4. review the rendered saved plan
5. `terraform apply terraform.tfplan`

Apply is refused until a saved plan exists, and a plan becomes invalid if the sandbox definition changes. Destroy uses a separate saved destroy plan, requires `worlds:delete`, and requires typing the exact sandbox name. Runs for the same sandbox are serialized, can be canceled, and survive Studio restarts as inspectable history. Set `terraform.binary` to an absolute path when Terraform is not in the Studio service's `PATH`; set `terraform.enabled` to `false` to disable execution while retaining source preview.

## Cluster Replication And Observability

KakuriZai can keep a joined-node registry and replicate a saved sandbox across those nodes. Issue a join token on the controller, then register nodes:

```sh
agctl node join-token --uses 3
agctl node join --token "$TOKEN" --name worker-a --id ins-a --ip 10.0.0.10
agctl node list
```

Replicate a sandbox to joined nodes:

```sh
agctl replicate demo --replicas 2
agctl replicate demo --node worker-a --state-mode stateful --replace --json
```

For running CubeMaster-backed sandboxes, replication now captures state before creating replicas. `stateful` is the default: KakuriZai first materializes mounted `/workspace` state into the sandbox rootfs when host mounts are present, then creates a CubeMaster runtime snapshot. Replicas placed on the snapshot origin node use that runtime snapshot, including memory snapshot metadata. Replicas placed on other nodes use a committed AppSnapshot template distributed to the requested node, which preserves the current rootfs/writable state but not live RAM. Use `--state-mode runtime-snapshot` to require same-node runtime snapshot restore, `--state-mode template-snapshot` for portable cross-node rootfs state, or `--state-mode definition` only for explicit definition-only placement.

For CubeMaster-backed sandboxes, replica requests carry placement metadata plus `ins_id`/`ins_ip`, `distribution_scope`, and the Cube debug annotation so CubeMaster can schedule the sandbox on the requested node and bind it to the matching template/snapshot locality. Replicas are tracked as normal worlds with `kakurizai.replicaOf`, `kakurizai.replication.group`, placement metadata, and `kakurizai.replication.stateMode`.

Studio includes an Observability view for node, sandbox, and replica metrics. CLI and API access are also available:

```sh
agctl metrics
agctl metrics --prometheus
agctl trace start --target world --ref <sandbox-id>
agctl trace list --json
agctl trace stop <trace-id>
```

Metrics are retained under `$KAKURIZAI_HOME/store/observability/metrics.json`; trace sessions and events are stored in `$KAKURIZAI_HOME/store/observability/traces.json`. The Studio API exposes `/api/observability/metrics`, `/api/observability/prometheus`, and `/api/observability/traces`.

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
