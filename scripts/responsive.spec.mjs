import { expect, test } from "@playwright/test";

const baseURL = process.env.STUDIO_URL || "http://127.0.0.1:5173";

const worlds = [
  {
    id: "world-a",
    name: "kakurizai-mobile-validation-sandbox-with-a-long-name",
    status: "running",
    sourcePath: "/home/mizuame/projects/very/long/path/that/should/truncate/on/mobile",
    backend: "cube-sandbox-overlay",
    createdAt: "2026-06-28T00:00:00.000Z",
    updatedAt: "2026-06-28T00:00:00.000Z",
    sandbox: {
      id: "runtime-a",
      baseId: "template-mobile-validation",
      status: "running",
      sandboxIp: "192.168.64.21",
      bootstrap: { applied: true }
    },
    backendConfig: {
      mountMode: "agctl-overlay",
      writableLayerSize: "4G",
      cpu: "2000m",
      memory: "2048Mi",
      networkType: "tap",
      network: {
        type: "tap",
        mode: "tap",
        sandboxIp: "192.168.64.21",
        allowInternetAccess: true,
        denyOut: ["10.0.0.0/8"]
      },
      kubernetes: {
        enabled: true,
        profile: "k3s",
        clusterName: "kakurizai",
        nodeRole: "control-plane",
        nodeName: "mobile-a"
      },
      mounts: [
        {
          name: "project",
          sourcePath: "/home/mizuame/projects/kakurizai",
          sandboxPath: "/workspace/project",
          mode: "agctl-overlay"
        }
      ]
    },
    diskUsage: { upperBytes: 10485760, logsBytes: 262144 }
  },
  {
    id: "world-b",
    name: "paused-worker",
    status: "paused",
    sourcePath: "",
    backend: "cube-sandbox-overlay",
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
    sandbox: { id: "runtime-b", status: "paused", sandboxIp: "192.168.64.22" },
    backendConfig: { cpu: "1000m", memory: "1024Mi", writableLayerSize: "2G", networkType: "tap" },
    diskUsage: { upperBytes: 0, logsBytes: 0 }
  }
];

const cube = {
  available: true,
  mode: "mock",
  namespace: "kakurizai-test",
  template: "template-mobile-validation",
  templates: [
    {
      id: "template-mobile-validation",
      status: "ready",
      createdAt: "2026-06-28T00:00:00.000Z",
      cpu: "2000m",
      memory: "2048Mi",
      writableLayerSize: "4G",
      networkType: "tap",
      allowInternetAccess: true,
      artifactSizeBytes: 73400320,
      exposedPorts: "22, 8080",
      probePath: "/healthz",
      probePort: 8080,
      replicas: [
        { id: "replica-a", status: "ready", node: "node-a", ip: "192.168.64.21" }
      ]
    }
  ],
  sandboxes: [
    {
      id: "runtime-a",
      status: "running",
      hostId: "node-a",
      hostIp: "10.0.0.10",
      sandboxIp: "192.168.64.21",
      createdAt: "2026-06-28T00:00:00.000Z",
      templateId: "template-mobile-validation",
      namespace: "kakurizai-test",
      cpu: "2000m",
      memory: "2048Mi",
      writableLayerSize: "4G",
      systemDiskSize: "20G",
      hostDataDiskMB: 5120,
      volumeMounts: [
        {
          name: "project",
          container_path: "/workspace/project",
          host_path: "/home/mizuame/projects/kakurizai",
          readonly: true,
          mode: "agctl-overlay"
        }
      ],
      portMappings: [{ container_port: 8080, host_port: 18080 }]
    },
    {
      id: "runtime-b",
      status: "paused",
      hostId: "node-b",
      sandboxIp: "192.168.64.22",
      templateId: "template-mobile-validation",
      cpu: "1000m",
      memory: "1024Mi",
      writableLayerSize: "2G"
    }
  ],
  nodes: [
    {
      id: "node-a",
      nodeId: "node-a",
      ip: "10.0.0.10",
      status: "ready",
      healthy: true,
      cpuTotal: 8,
      memTotalMB: 16384,
      quotaCpuUsage: 2,
      quotaMemUsage: 2048,
      dataDiskUsagePer: 40,
      storageDiskUsagePer: 30,
      sysDiskUsagePer: 20
    }
  ],
  storage: [{ nodeId: "node-a", nodeIp: "10.0.0.10", mode: "local", usagePct: 40 }],
  config: {
    apiEndpoint: "http://127.0.0.1:8080",
    authEnabled: false,
    sandboxDomain: "local.test",
    instanceType: "standard",
    networkType: "tap"
  },
  capabilities: { destroy: true, logs: true, pause: true, resume: true }
};

const mainViewports = [
  { name: "phone-320", width: 320, height: 568 },
  { name: "phone-390", width: 390, height: 844 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "desktop-1280", width: 1280, height: 800 }
];

const terminalViewports = [
  { name: "terminal-phone-320", width: 320, height: 568, minFrameHeight: 360 },
  { name: "terminal-phone-390", width: 390, height: 740, minFrameHeight: 500 },
  { name: "terminal-landscape", width: 844, height: 390, minFrameHeight: 230 },
  { name: "terminal-desktop", width: 1280, height: 800, minFrameHeight: 690 }
];

test.describe("Studio responsive layout", () => {
  for (const viewport of mainViewports) {
    test(`dashboard has no measured overlap at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockApi(page);
      await page.goto(baseURL);
      await page.waitForSelector(".workbench");
      await page.waitForSelector(".sandboxItem");
      const report = await auditLayout(page, viewport.name);
      console.log(JSON.stringify(report.summary));
      expect(report.failures).toEqual([]);
    });

    test(`new sandbox menu fits at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockApi(page);
      await page.goto(baseURL);
      await page.waitForSelector(".workbench");
      await page.getByTitle("Menu").click();
      await page.getByText("Create Sandbox").click();
      await page.waitForSelector(".newSandboxMenu");
      const report = await auditLayout(page, `${viewport.name}-menu`);
      console.log(JSON.stringify(report.summary));
      expect(report.failures).toEqual([]);
    });

    test(`network view has no measured overlap at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockApi(page);
      await page.goto(baseURL);
      await page.waitForSelector(".workbench");
      await page.getByTitle("Network").click();
      await page.waitForSelector(".networkWorkspace");
      const report = await auditLayout(page, `${viewport.name}-network`);
      console.log(JSON.stringify(report.summary));
      expect(report.failures).toEqual([]);
    });
  }

  for (const viewport of terminalViewports) {
    test(`terminal is measurable and non-overlapping at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockApi(page);
      await page.goto(`${baseURL}/shell/world-a`);
      await page.waitForSelector(".terminalFrame .xterm");
      const report = await auditLayout(page, viewport.name);
      const terminal = report.summary.terminal;
      console.log(JSON.stringify(report.summary));
      expect(report.failures).toEqual([]);
      expect(terminal.frame.width).toBeGreaterThan(viewport.width - 24);
      expect(terminal.frame.height).toBeGreaterThanOrEqual(viewport.minFrameHeight);
      expect(terminal.xterm.width).toBeGreaterThan(terminal.frame.width - 24);
      expect(terminal.xterm.height).toBeGreaterThan(terminal.frame.height - 24);
    });
  }
});

async function mockApi(page) {
  await page.route("**/api/auth/config", (route) => json(route, {
    provider: "none",
    label: "Local development",
    requiresToken: false
  }));
  await page.route("**/api/session", (route) => json(route, { user: { subject: "responsive-test" } }));
  await page.route("**/api/cube/inspect", (route) => json(route, cube));
  await page.route("**/api/network/probe", (route) => json(route, {
    generatedAt: "2026-06-28T00:00:00.000Z",
    nodes: [],
    edges: [],
    forwards: []
  }));
  await page.route("**/api/host/browse**", (route) => json(route, {
    path: "/home/mizuame/projects/kakurizai",
    parent: "/home/mizuame/projects",
    entries: [
      { name: "src", path: "/home/mizuame/projects/kakurizai/src", type: "directory" },
      { name: "test", path: "/home/mizuame/projects/kakurizai/test", type: "directory" }
    ]
  }));
  await page.route("**/api/worlds/*/dev-access**", (route) => json(route, {
    worldId: "world-a",
    worldName: "kakurizai-mobile-validation-sandbox-with-a-long-name",
    sandboxIp: "192.168.64.21",
    workspace: "/workspace/project",
    sshHost: "127.0.0.1",
    sshPort: 2222,
    sshCommand: "ssh root@127.0.0.1 -p 2222"
  }));
  await page.route("**/api/worlds", (route) => json(route, worlds));
}

function json(route, value) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(value)
  });
}

async function auditLayout(page, label) {
  return page.evaluate((auditLabel) => {
    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight,
      visualHeight: window.visualViewport?.height || window.innerHeight
    };
    const failures = [];
    const px = (value) => Math.round(value * 10) / 10;

    const rectOf = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: px(rect.left),
        top: px(rect.top),
        right: px(rect.right),
        bottom: px(rect.bottom),
        width: px(rect.width),
        height: px(rect.height)
      };
    };

    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) !== 0 &&
        rect.width > 0.5 &&
        rect.height > 0.5 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < viewport.height &&
        rect.left < viewport.width;
    };

    const describe = (element) => {
      const classes = [...element.classList].slice(0, 4).join(".");
      const suffix = classes ? `.${classes}` : "";
      const text = (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 48);
      return `${element.tagName.toLowerCase()}${suffix}${text ? ` "${text}"` : ""}`;
    };

    const boundedSelectors = [
      ".workbench",
      ".terminalPage",
      ".activityBar",
      ".sandboxPanel",
      ".mainArea",
      ".titleBar",
      ".editorPane",
      ".newSandboxMenu",
      ".terminalTopbar",
      ".terminalFrame",
      ".terminalFrame .xterm"
    ];

    for (const selector of boundedSelectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!visible(element)) continue;
        const rect = rectOf(element);
        if (rect.left < -1 || rect.top < -1 || rect.right > viewport.width + 1 || rect.bottom > viewport.height + 1) {
          failures.push({
            type: "viewport-bounds",
            selector,
            element: describe(element),
            rect,
            viewport
          });
        }
      }
    }

    const scrollSelectors = [
      ".workbench",
      ".terminalPage",
      ".mainArea",
      ".titleBar",
      ".terminalTopbar",
      ".terminalFrame",
      ".sandboxPanel"
    ];

    for (const selector of scrollSelectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!visible(element)) continue;
        const style = window.getComputedStyle(element);
        const allowed = ["auto", "hidden", "scroll", "clip"].includes(style.overflowX);
        if (element.scrollWidth > element.clientWidth + 2 && !allowed) {
          failures.push({
            type: "horizontal-overflow",
            selector,
            element: describe(element),
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
            overflowX: style.overflowX
          });
        }
      }
    }

    const overlapGroups = [
      { name: "workbench-panes", selector: ".workbench > .activityBar, .workbench > .sandboxPanel, .workbench > .mainArea", byParent: false },
      { name: "terminal-panes", selector: ".terminalPage > .terminalTopbar, .terminalPage > .terminalFrame", byParent: false },
      { name: "titlebar-children", selector: ".titleBar > *", byParent: true },
      { name: "terminal-topbar-children", selector: ".terminalTopbar > *", byParent: true },
      { name: "toolbar-children", selector: ".toolbarActions > *", byParent: true },
      { name: "network-header-children", selector: ".networkWorkspaceHeader > *", byParent: true }
    ];

    for (const group of overlapGroups) {
      const elements = [...document.querySelectorAll(group.selector)].filter(visible);
      const buckets = group.byParent
        ? [...new Set(elements.map((element) => element.parentElement))].map((parent) => elements.filter((element) => element.parentElement === parent))
        : [elements];
      for (const bucket of buckets) {
        for (let i = 0; i < bucket.length; i += 1) {
          for (let j = i + 1; j < bucket.length; j += 1) {
            const a = rectOf(bucket[i]);
            const b = rectOf(bucket[j]);
            const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (width > 1 && height > 1) {
              failures.push({
                type: "overlap",
                group: group.name,
                a: describe(bucket[i]),
                b: describe(bucket[j]),
                intersection: { width: px(width), height: px(height), area: px(width * height) },
                rects: { a, b }
              });
            }
          }
        }
      }
    }

    for (const button of document.querySelectorAll("button")) {
      if (!visible(button)) continue;
      if (button.scrollWidth > button.clientWidth + 1) {
        failures.push({
          type: "button-text-overflow",
          element: describe(button),
          rect: rectOf(button),
          scrollWidth: button.scrollWidth,
          clientWidth: button.clientWidth
        });
      }
    }

    const landmarkSelectors = [
      ".workbench",
      ".activityBar",
      ".sandboxPanel",
      ".mainArea",
      ".titleBar",
      ".editorPane",
      ".newSandboxMenu",
      ".terminalPage",
      ".terminalTopbar",
      ".terminalFrame",
      ".terminalFrame .xterm"
    ];

    const landmarks = {};
    for (const selector of landmarkSelectors) {
      const element = document.querySelector(selector);
      if (element && visible(element)) landmarks[selector] = rectOf(element);
    }

    const terminalFrame = document.querySelector(".terminalFrame");
    const xterm = document.querySelector(".terminalFrame .xterm");
    const terminal = terminalFrame && xterm
      ? { frame: rectOf(terminalFrame), xterm: rectOf(xterm) }
      : null;

    return {
      failures,
      summary: {
        label: auditLabel,
        viewport,
        failureCount: failures.length,
        landmarks,
        terminal
      }
    };
  }, label);
}
