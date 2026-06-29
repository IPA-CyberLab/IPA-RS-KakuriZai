#!/usr/bin/env bash
set -euo pipefail

SOURCE_CONTAINER=${KAKURIZAI_SOURCE_CONTAINER:-kz-cs-control}
TARGET_CONTAINER_DEFAULT=${KAKURIZAI_TARGET_CONTAINER:-kz-cs-worker}
TEMPLATE_ID=${KAKURIZAI_TEMPLATE_ID:?KAKURIZAI_TEMPLATE_ID is required}
CONTEXT_PATH=${KAKURIZAI_REPLICATION_CONTEXT:?KAKURIZAI_REPLICATION_CONTEXT is required}
SNAPSHOT_BASE=${KAKURIZAI_CUBE_SNAPSHOT_BASE:-/usr/local/services/cubetoolbox/cube-snapshot/cubebox}
PATH=/usr/local/bin:/usr/bin:/bin:$PATH

workdir=$(mktemp -d /tmp/kz-direct-restore.XXXXXX)
cleanup() { rm -rf "$workdir"; }
trap cleanup EXIT

die() {
  printf 'direct restore failed: %s\n' "$*" >&2
  exit 1
}

context_json=$workdir/context.json
lxc exec "$SOURCE_CONTAINER" -- cat "$CONTEXT_PATH" > "$context_json" || die "cannot read context from $SOURCE_CONTAINER:$CONTEXT_PATH"

target_container=$(jq -r --arg d "$TARGET_CONTAINER_DEFAULT" '.executor.container // .target.executor.container // $d' "$context_json")
namespace=$(jq -r '.cube.namespace // "kakurizai"' "$context_json")
target_node_id=$(jq -r --arg env "${KAKURIZAI_TARGET_NODE_ID:-}" '.target.nodeId // .target.id // $env // empty' "$context_json")
target_node_name=$(jq -r --arg env "${KAKURIZAI_TARGET_NODE_NAME:-}" '.target.name // $env // empty' "$context_json")
target_node_ip=$(jq -r --arg env "${KAKURIZAI_TARGET_NODE_IP:-}" '.target.ip // $env // empty' "$context_json")
runtime_snapshot_id=$(jq -r --arg env "${KAKURIZAI_RUNTIME_SNAPSHOT_ID:-}" '.runtimeSnapshotId // $env // empty' "$context_json")

[ -n "$target_container" ] || die "target executor container is missing"
[ -n "$target_node_id" ] || die "target node id is missing"
[ -n "$runtime_snapshot_id" ] || die "runtime snapshot id is missing"

copy_path() {
  local src_path=$1
  lxc exec "$SOURCE_CONTAINER" -- test -e "$src_path" || die "missing source artifact $src_path"
  lxc exec "$SOURCE_CONTAINER" -- tar --sparse -C / -cpf - "${src_path#/}" | lxc exec "$target_container" -- tar -C / -xpf -
}

snapshot_dir=$SNAPSHOT_BASE/$TEMPLATE_ID
copy_path "$snapshot_dir"

catalog_json=$workdir/catalog.json
lxc exec "$SOURCE_CONTAINER" -- cat "$snapshot_dir/2C2000M/catalog.json" > "$catalog_json" || die "cannot read template catalog"
memory_vol=$(jq -r '.memory_vol // empty' "$catalog_json")
for key in rootfs_vol memory_vol; do
  volume_name=$(jq -r ".$key // empty" "$catalog_json")
  [ -n "$volume_name" ] || continue
  volume_path=$(lxc exec "$SOURCE_CONTAINER" -- bash -lc 'find /data/cubelet/storage/cubecow-reflink/volumes -mindepth 2 -maxdepth 2 -name "$1" -print -quit' _ "$volume_name" | tr -d '\r')
  [ -n "$volume_path" ] || die "cannot locate $volume_name"
  copy_path "$volume_path"
done

lxc exec "$target_container" -- systemctl restart cube-sandbox-cubelet.service >/dev/null
sleep "${KAKURIZAI_TARGET_CUBELET_RESTART_WAIT:-3}"
lxc exec "$target_container" -- systemctl is-active --quiet cube-sandbox-cubelet.service || die "target cubelet did not restart"

snapshot_info=$workdir/snapshot-info.json
lxc exec "$SOURCE_CONTAINER" -- bash -lc 'export PATH=/usr/local/services/cubetoolbox/CubeMaster/bin:/usr/local/services/cubetoolbox/Cubelet/bin:$PATH; cubemastercli snapshot info --snapshot-id "$1" --include-request --json' _ "$runtime_snapshot_id" > "$snapshot_info" || die "cannot read runtime snapshot create request"

request_json=$workdir/request.json
jq --arg tpl "$TEMPLATE_ID" \
   --arg namespace "$namespace" \
   --arg nodeId "$target_node_id" \
   --arg nodeName "$target_node_name" \
   --arg nodeIp "${target_node_ip:-$target_node_id}" '
  .snapshot.create_request
  | .namespace = $namespace
  | del(.ins_id, .ins_ip, .distribution_scope)
  | .annotations = (.annotations // {})
  | .annotations["cube.master.appsnapshot.template.id"] = $tpl
  | .annotations["cube.master.appsnapshot.template.version"] = "v2"
  | .annotations["cube.master.appsnapshot.version"] = "v2"
  | .annotations["cube.master.runtime.snapshot.id"] = $tpl
  | .annotations["cube.master.runtime.restore.snapshot.id"] = $tpl
  | .annotations["kakurizai.placement.nodeId"] = $nodeId
  | .annotations["kakurizai.placement.nodeIp"] = $nodeIp
  | .annotations["kakurizai.placement.nodeName"] = $nodeName
  | .labels = (.labels // {})
  | .labels["cube.master.appsnapshot.template.id"] = $tpl
  | .labels["kakurizai.placement.node"] = $nodeId
  | .containers |= map(
      .image = (.image // {})
      | .image.annotations = ((.image.annotations // {}) + {
          "cube.master.appsnapshot.template.id": $tpl,
          "cube.master.appsnapshot.template.version": "v2",
          "cube.master.runtime.snapshot.id": $tpl
        })
    )
  | .volumes |= map(
      if .volume_source.empty_dir then
        .volume_source.empty_dir.SizeLimit = (.volume_source.empty_dir.SizeLimit // .volume_source.empty_dir.size_limit // "1G")
        | del(.volume_source.empty_dir.size_limit)
      else . end
    )
' "$snapshot_info" > "$request_json" || die "cannot build worker create request"

remote_request=/tmp/kz-direct-restore-$TEMPLATE_ID.json
lxc file push "$request_json" "$target_container$remote_request" >/dev/null

create_log=$workdir/create.log
if ! lxc exec "$target_container" -- bash -lc 'export PATH=/usr/local/services/cubetoolbox/Cubelet/bin:$PATH; cubecli --namespace "$1" cubebox create --rm=false "$2"' _ "$namespace" "$remote_request" > "$create_log" 2>&1; then
  sed -e 's/[{}]/()/g' "$create_log" >&2
  die "worker cubecli create failed"
fi

response_json=$(grep -Eo '\{.*\}' "$create_log" | tail -n 1 || true)
sandbox_id=""
sandbox_ip=""
if [ -n "$response_json" ]; then
  sandbox_id=$(printf '%s' "$response_json" | jq -r '.sandBoxID // .SandBoxID // .sandboxId // .sandbox_id // .containerId // .id // empty' 2>/dev/null || true)
  sandbox_ip=$(printf '%s' "$response_json" | jq -r '.ip // .Ip // .sandboxIp // .sandbox_ip // empty' 2>/dev/null || true)
fi
if [ -z "$sandbox_id" ]; then
  sandbox_id=$(grep -Eo '[0-9a-f]{32}' "$create_log" | tail -n 1 || true)
fi
[ -n "$sandbox_id" ] || die "worker cubecli create did not return a sandbox id"

captures_memory=false
if [ -n "$memory_vol" ]; then
  captures_memory=true
fi

jq -nc --arg sandboxId "$sandbox_id" \
  --arg containerId "$sandbox_id" \
  --arg sandboxIp "$sandbox_ip" \
  --arg nodeId "$target_node_id" \
  --arg nodeName "$target_node_name" \
  --arg templateId "$TEMPLATE_ID" \
  --arg runtimeSnapshotId "$TEMPLATE_ID" \
  --argjson capturesMemory "$captures_memory" \
  '{sandboxId:$sandboxId,containerId:$containerId,nodeId:$nodeId,nodeName:$nodeName,templateId:$templateId,runtimeSnapshotId:$runtimeSnapshotId,capturesMemory:$capturesMemory,continuousMemory:false} + (if $sandboxIp == "" then {} else {sandboxIp:$sandboxIp} end)'
