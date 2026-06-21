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
    nat: normalizeNatConfig(source.nat || source.natConfig || {}),
    exposedPorts,
    dns,
    allowOut: normalizeStringList(source.allowOut),
    denyOut: normalizeStringList(source.denyOut),
    rules: normalizeEgressRules(source.rules)
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

export function normalizeNatConfig(input = {}) {
  if (!input || input.enabled === false) {
    return {
      enabled: false,
      masquerade: false,
      outboundInterface: null,
      subnet: null,
      gateway: null,
      portForwards: []
    };
  }
  const portForwards = normalizePortForwards(input.portForwards || input.forwards || []);
  const outboundInterface = cleanString(input.outboundInterface || input.interface || input.iface || "");
  const subnet = cleanString(input.subnet || input.cidr || "");
  const gateway = cleanString(input.gateway || "");
  return {
    enabled: Boolean(input.enabled || input.masquerade || outboundInterface || subnet || gateway || portForwards.length),
    masquerade: input.masquerade !== false,
    outboundInterface: outboundInterface || null,
    subnet: subnet || null,
    gateway: gateway || null,
    portForwards
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

function normalizePortForwards(value) {
  const raw = Array.isArray(value) ? value : [];
  return raw.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error("nat.portForwards entries must be objects");
    const protocol = cleanString(item.protocol || "tcp").toLowerCase();
    if (!["tcp", "udp"].includes(protocol)) throw new Error("nat.portForwards.protocol must be tcp or udp");
    const hostPort = item.hostPort ?? item.listenPort ?? item.externalPort;
    const sandboxPort = item.sandboxPort ?? item.containerPort ?? item.targetPort;
    return {
      name: cleanString(item.name || `forward-${index + 1}`),
      protocol,
      listenAddress: cleanString(item.listenAddress || item.host || "") || null,
      hostPort: normalizePort(hostPort, "nat.portForwards.hostPort"),
      sandboxPort: normalizePort(sandboxPort, "nat.portForwards.sandboxPort"),
      targetAddress: cleanString(item.targetAddress || item.destination || "") || null
    };
  });
}

function normalizeEgressRules(value) {
  if (!value) return [];
  if (!Array.isArray(value)) throw new Error("network.rules must be an array");
  return value.map((rule, index) => {
    if (!rule || typeof rule !== "object") throw new Error("network.rules entries must be objects");
    const match = rule.match && typeof rule.match === "object" ? {
      ...(cleanString(rule.match.sni || "") ? { sni: cleanString(rule.match.sni) } : {}),
      ...(cleanString(rule.match.host || "") ? { host: cleanString(rule.match.host) } : {}),
      ...(normalizeStringList(rule.match.method || rule.match.methods).length ? { method: normalizeStringList(rule.match.method || rule.match.methods) } : {}),
      ...(cleanString(rule.match.path || "") ? { path: cleanString(rule.match.path) } : {}),
      ...(cleanString(rule.match.scheme || "") ? { scheme: cleanString(rule.match.scheme) } : {})
    } : undefined;
    const actionSource = rule.action && typeof rule.action === "object" ? rule.action : {};
    const action = {
      allow: actionSource.allow !== undefined ? Boolean(actionSource.allow) : true,
      ...(cleanString(actionSource.audit || "") ? { audit: cleanString(actionSource.audit) } : {}),
      ...(Array.isArray(actionSource.inject) && actionSource.inject.length ? {
        inject: actionSource.inject.map((inject) => ({
          header: cleanString(inject.header),
          secret: cleanString(inject.secret),
          ...(cleanString(inject.format || "") ? { format: cleanString(inject.format) } : {})
        })).filter((inject) => inject.header && inject.secret)
      } : {})
    };
    return {
      name: cleanString(rule.name || `rule-${index + 1}`),
      ...(match && Object.keys(match).length ? { match } : {}),
      action
    };
  });
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
