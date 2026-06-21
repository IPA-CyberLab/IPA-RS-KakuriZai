import assert from "node:assert/strict";
import test from "node:test";
import {
  applyProbeChecks,
  buildNetworkProbePlan,
  buildProbeScript,
  parseProbeOutput
} from "../dist/src/core/probe.js";

test("network probe plan maps worlds to sandbox IPs, ports, NAT forwards, and edges", () => {
  const worlds = [
    {
      id: "alpha-aaaaaaaaaaaa",
      name: "alpha",
      status: "ready",
      sandbox: { id: "sandbox-alpha-long", status: "running" },
      backendConfig: {
        network: {
          type: "tap",
          exposedPorts: [8080],
          nat: {
            enabled: true,
            masquerade: true,
            portForwards: [{ name: "ssh", protocol: "tcp", hostPort: 2222, sandboxPort: 22 }]
          }
        },
        kubernetes: {
          enabled: true,
          profile: "k3s",
          clusterName: "lab-a",
          nodeRole: "control-plane",
          nodeName: "cp-1",
          podCidr: "10.42.0.0/16",
          serviceCidr: "10.43.0.0/16",
          joinEndpoint: "https://alpha:6443",
          apiServerPort: 6443,
          nodePorts: [30000]
        }
      }
    },
    {
      id: "beta-bbbbbbbbbbbb",
      name: "beta",
      status: "ready",
      sandbox: { id: "sandbox-beta-long", status: "running" },
      backendConfig: {
        network: { type: "tap", exposedPorts: [9090] },
        kubernetes: { enabled: false }
      }
    }
  ];
  const runtimes = [
    { id: "sandbox-alpha-long", sandboxIp: "10.0.0.10", hostIp: "192.0.2.10", portMappings: [{ container_port: 13337 }] },
    { id: "sandbox-beta-long", sandboxIp: "10.0.0.11", hostIp: "192.0.2.10" }
  ];

  const plan = buildNetworkProbePlan(worlds, runtimes);

  assert.equal(plan.nodes.length, 2);
  assert.deepEqual(plan.nodes[0].exposedPorts, [6443, 8080, 13337, 30000]);
  assert.equal(plan.nodes[0].sandboxIp, "10.0.0.10");
  assert.deepEqual(plan.nodes[0].kubernetes, {
    enabled: true,
    profile: "k3s",
    clusterName: "lab-a",
    nodeRole: "control-plane",
    nodeName: "cp-1",
    podCidr: "10.42.0.0/16",
    serviceCidr: "10.43.0.0/16",
    joinEndpoint: "https://alpha:6443",
    apiServerPort: 6443,
    nodePorts: [30000]
  });
  assert.equal(plan.edges.length, 2);
  assert.equal(plan.edges[0].hostPath, "same-host");
  assert.equal(plan.edges[0].checks[0].kind, "icmp");
  assert.deepEqual(plan.forwards, [
    {
      worldId: "alpha-aaaaaaaaaaaa",
      worldName: "alpha",
      name: "ssh",
      protocol: "tcp",
      listenAddress: null,
      hostPort: 2222,
      sandboxPort: 22,
      targetAddress: null
    }
  ]);
});

test("network probe script output is parsed and applied to edges", () => {
  const plan = buildNetworkProbePlan([
    { id: "alpha", name: "alpha", status: "ready", sandbox: { id: "a" }, backendConfig: { network: { type: "tap" } } },
    { id: "beta", name: "beta", status: "ready", sandbox: { id: "b" }, backendConfig: { network: { type: "tap", exposedPorts: [80] } } }
  ], [
    { id: "a", sandboxIp: "10.0.0.10" },
    { id: "b", sandboxIp: "10.0.0.11" }
  ]);

  const script = buildProbeScript([{ worldId: "beta", ip: "10.0.0.11", ports: [80] }]);
  assert.match(script, /probe_ping/);
  assert.match(script, /tcp:'80'/);

  const checks = parseProbeOutput([
    "noise",
    "KAKURIZAI_PROBE\tbeta\t10.0.0.11\ticmp\tfail\t1",
    "KAKURIZAI_PROBE\tbeta\t10.0.0.11\ttcp:80\tok\t-"
  ].join("\n"));
  const result = applyProbeChecks(plan, "alpha", checks);
  const edge = result.edges.find((candidate) => candidate.fromWorldId === "alpha" && candidate.toWorldId === "beta");

  assert.equal(edge.reachable, true);
  assert.equal(edge.reason, null);
  assert.deepEqual(edge.checks.map((check) => `${check.kind}:${check.status}`), ["icmp:fail", "tcp:80:ok"]);
});
