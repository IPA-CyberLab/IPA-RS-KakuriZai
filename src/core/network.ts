// @ts-nocheck
export function normalizeNetworkConfig(input = {}) {
  const source = input || {};
  const type = cleanString(source.type || source.networkType || "tap");
  if (type !== "tap") {
    throw new Error(`CubeSandbox OSS currently supports network.type=tap only; ${type} requires a CubeSandbox network plugin or host-side VLAN bridge integration.`);
  }
  const exposedPorts = normalizePortList(source.exposedPorts || source.ports || []);
  const dns = normalizeDnsConfig(source.dns || source.dnsConfig || {});
  const allowInternetAccess = source.allowInternetAccess;
  const network = {
    type,
    mode: cleanString(source.mode || type),
    vlan: normalizeVlanConfig(source.vlan || {}),
    exposedPorts,
    dns,
    allowOut: normalizeStringList(source.allowOut),
    denyOut: normalizeStringList(source.denyOut),
    rules: Array.isArray(source.rules) ? source.rules : []
  };
  if (allowInternetAccess !== undefined && allowInternetAccess !== null && allowInternetAccess !== "") {
    network.allowInternetAccess = Boolean(allowInternetAccess);
  }
  return network;
}

export function normalizeVlanConfig(input = {}) {
  if (!input || input.enabled === false) {
    return { enabled: false, vlanId: null, hostInterface: null, bridgeName: null };
  }
  const vlanId = input.vlanId ?? input.id;
  return {
    enabled: Boolean(input.enabled || vlanId || input.hostInterface || input.bridgeName),
    vlanId: vlanId == null || vlanId === "" ? null : normalizeVlanId(vlanId),
    hostInterface: cleanString(input.hostInterface || input.interface || ""),
    bridgeName: cleanString(input.bridgeName || input.bridge || "")
  };
}

export function normalizeKubernetesConfig(input = {}) {
  if (input === true) input = { enabled: true };
  const enabled = Boolean(input?.enabled);
  const profile = cleanString(input?.profile || "k3s");
  return {
    enabled,
    profile,
    apiServerPort: normalizePort(input?.apiServerPort || 6443, "kubernetes.apiServerPort"),
    nodePorts: normalizePortList(input?.nodePorts || (enabled ? [30000, 30001] : [])),
    sysctls: {
      ...(enabled ? {
        "net.ipv4.ip_forward": "1",
        "net.bridge.bridge-nf-call-iptables": "1",
        "net.bridge.bridge-nf-call-ip6tables": "1"
      } : {}),
      ...(input?.sysctls || {})
    }
  };
}

export function effectiveNetworkConfig(network = {}, kubernetes = {}) {
  const normalizedNetwork = normalizeNetworkConfig(network);
  const normalizedKubernetes = normalizeKubernetesConfig(kubernetes);
  const exposedPorts = new Set(normalizedNetwork.exposedPorts);
  if (normalizedKubernetes.enabled) {
    exposedPorts.add(normalizedKubernetes.apiServerPort);
    for (const port of normalizedKubernetes.nodePorts) exposedPorts.add(port);
  }
  return {
    ...normalizedNetwork,
    exposedPorts: [...exposedPorts].sort((a, b) => a - b),
    dns: effectiveDnsConfig(normalizedNetwork.dns, normalizedKubernetes)
  };
}

export function cubeNetworkPolicy(network = {}) {
  const policy = {};
  if (network.allowInternetAccess !== undefined) policy.allowInternetAccess = Boolean(network.allowInternetAccess);
  if (network.allowOut?.length) policy.allowOut = network.allowOut;
  if (network.denyOut?.length) policy.denyOut = network.denyOut;
  if (network.rules?.length) policy.rules = network.rules;
  return Object.keys(policy).length ? policy : null;
}

export function normalizePortList(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[,\s]+/);
  const ports = [];
  for (const item of raw) {
    if (item === null || item === undefined || item === "") continue;
    const port = typeof item === "object" ? item.containerPort || item.container_port || item.port : item;
    ports.push(normalizePort(port, "port"));
  }
  return [...new Set(ports)].sort((a, b) => a - b);
}

export function parseBooleanOption(value) {
  if (value === true || value === false) return value;
  const normalized = String(value || "").trim().toLowerCase();
  if (["true", "1", "yes", "on", "allow", "allowed"].includes(normalized)) return true;
  if (["false", "0", "no", "off", "deny", "denied", "blocked"].includes(normalized)) return false;
  throw new Error(`invalid boolean value: ${value}`);
}

function normalizePort(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) {
    throw new Error(`${name} must be a TCP port between 1 and 65535`);
  }
  return number;
}

function normalizeVlanId(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 4094) {
    throw new Error("vlan.id must be between 1 and 4094");
  }
  return number;
}

function normalizeDnsConfig(input = {}) {
  return {
    servers: normalizeStringList(input.servers || input.nameservers),
    searches: normalizeStringList(input.searches),
    options: normalizeStringList(input.options)
  };
}

function effectiveDnsConfig(dns, kubernetes) {
  const searches = new Set(dns.searches || []);
  const options = new Set(dns.options || []);
  if (kubernetes.enabled) {
    searches.add("svc.cluster.local");
    searches.add("cluster.local");
    options.add("ndots:5");
  }
  return {
    servers: dns.servers || [],
    searches: [...searches],
    options: [...options]
  };
}

function normalizeStringList(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : String(value).split(/[,\n]+/);
  return raw.map((item) => String(item).trim()).filter(Boolean);
}

function cleanString(value) {
  return String(value || "").trim();
}
