import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeSystemSnapshot, primaryProcessPort, sortSystemProcesses } from "../src/model/system.js";
import { renderActivePanel, renderSubtabs } from "../src/views/panels.js";
import { createInitialState, reduceState } from "../src/model/state.js";

test("system state records snapshots and sort preference", () => {
  let state = createInitialState();
  assert.equal(state.system.status, "idle");
  state = reduceState(state, { type: "SYSTEM_SORT_SET", payload: { sortBy: "port" } });
  assert.equal(state.system.sortBy, "port");
  state = reduceState(state, { type: "SYSTEM_SNAPSHOT_SET", payload: { snapshot: normalizeSystemSnapshot({ processes: [{ pid: 12, name: "node" }] }) } });
  assert.equal(state.system.status, "ready");
  assert.equal(state.system.snapshot.processes[0].pid, 12);
});

test("process sorting by CPU uses memory as a tie breaker", () => {
  const sorted = sortSystemProcesses([
    { pid: 1, name: "low", cpuPercent: 1, memoryBytes: 900 },
    { pid: 2, name: "high", cpuPercent: 30, memoryBytes: 100 },
    { pid: 3, name: "high-memory", cpuPercent: 30, memoryBytes: 200 }
  ], "cpu");
  assert.deepEqual(sorted.map((item) => item.pid), [3, 2, 1]);
});

test("process sorting by port keeps processes without ports at the end", () => {
  const sorted = sortSystemProcesses([
    { pid: 1, name: "no-port", ports: [] },
    { pid: 2, name: "web", ports: [8080] },
    { pid: 3, name: "ssh", ports: [22, 2222] },
    { pid: 4, name: "also-no-port", ports: [] }
  ], "port");
  assert.deepEqual(sorted.map((item) => item.pid), [3, 2, 4, 1]);
  assert.equal(primaryProcessPort(sorted[0]), 22);
  assert.equal(primaryProcessPort(sorted.at(-1)), null);
});

test("system snapshot normalization derives memory and swap usage", () => {
  const snapshot = normalizeSystemSnapshot({
    memory: { totalBytes: 1000, usedBytes: 250, swapTotalBytes: 2000, swapUsedBytes: 500 },
    processes: [{ pid: "5", ports: ["443", "bad", 80] }]
  });
  assert.equal(snapshot.memory.usagePercent, 25);
  assert.equal(snapshot.memory.swapUsagePercent, 25);
  assert.equal(snapshot.memory.swapFreeBytes, 1500);
  assert.deepEqual(snapshot.processes[0].ports, [80, 443]);
  assert.equal(snapshot.processes[0].downloadBytes, 0);
  assert.equal(snapshot.processes[0].uploadBytes, 0);
});


test("default process sorting puts port users first then falls back to CPU", () => {
  const sorted = sortSystemProcesses([
    { pid: 1, name: "busy", cpuPercent: 90, memoryBytes: 1_000, ports: [] },
    { pid: 2, name: "web", cpuPercent: 5, memoryBytes: 1_000, ports: [8080] },
    { pid: 3, name: "api", cpuPercent: 8, memoryBytes: 1_000, ports: [3000] }
  ], "cpu");

  assert.deepEqual(sorted.map((item) => item.pid), [3, 2, 1]);
});

test("process sorting supports combined network traffic", () => {
  const sorted = sortSystemProcesses([
    { pid: 1, name: "quiet", downloadBytes: 9, uploadBytes: 1 },
    { pid: 2, name: "loud", downloadBytes: 50, uploadBytes: 50 },
    { pid: 3, name: "upload", downloadBytes: 0, uploadBytes: 70 }
  ], "net");

  assert.deepEqual(sorted.map((item) => item.pid), [2, 3, 1]);
});

test("system snapshot normalization keeps disk, process path, and read-write bytes", () => {
  const snapshot = normalizeSystemSnapshot({
    disk: { totalBytes: 4_000_000, usedBytes: 1_000_000, freeBytes: 3_000_000, readBytesPerSecond: 200_000, writeBytesPerSecond: 100_000 },
    processes: [{ pid: 5, name: "node", path: "/usr/local/bin/node", diskReadBytes: 7, diskWriteBytes: 11, downloadBytes: 13, uploadBytes: 17 }]
  });

  assert.equal(snapshot.disk.usagePercent, 25);
  assert.equal(snapshot.processes[0].path, "/usr/local/bin/node");
  assert.equal(snapshot.processes[0].diskReadBytes, 7);
  assert.equal(snapshot.processes[0].diskWriteBytes, 11);
});



test("system process names prefer readable app bundle names", () => {
  const snapshot = normalizeSystemSnapshot({
    processes: [
      { pid: 1, name: "Bl", path: "Bl", commandLine: "/Applications/Blender.app/Contents/MacOS/Blender --background" },
      { pid: 2, name: "Go", path: "Go", commandLine: "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper" },
      { pid: 3, name: "An", path: "An", commandLine: "/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper (Renderer).app/Contents/MacOS/Antigravity Helper" }
    ]
  });

  assert.deepEqual(snapshot.processes.map((process) => process.name), ["Blender", "Google Chrome", "Antigravity"]);
});

test("system panel uses compact cards and centered selected-process detail", () => {
  let state = createInitialState();
  state = { ...state, tabs: [{ ...state.tabs[0], activeSubtabId: "system-tab", subtabs: [...state.tabs[0].subtabs, { id: "system-tab", type: "system", title: "System" }] }] };
  state = reduceState(state, {
    type: "SYSTEM_SNAPSHOT_SET",
    payload: {
      snapshot: normalizeSystemSnapshot({
        capturedAt: "2026-01-01T00:00:00.000Z",
        host: { hostname: "auri-host" },
        memory: { totalBytes: 2_000_000, usedBytes: 1_000_000, swapTotalBytes: 2_000_000_000, swapUsedBytes: 1_000_000_000 },
        network: { downloadBytesPerSecond: 1_000_000, uploadBytesPerSecond: 500_000, totalRxBytes: 3_000_000, totalTxBytes: 4_000_000 },
        processes: [
          { pid: 10, name: "web", path: "/usr/bin/web", commandLine: "/usr/bin/web --serve very-long-project", memoryBytes: 2_000_000, cpuPercent: 1, downloadBytes: 1_000_000, uploadBytes: 500_000, diskReadBytes: 200_000, diskWriteBytes: 100_000, ports: [3000, 5173] }
        ]
      })
    }
  });
  state = reduceState(state, { type: "SYSTEM_PROCESS_SELECT", payload: { pid: 10 } });
  state = reduceState(state, { type: "SYSTEM_TUNNEL_SET", payload: { port: 5173, url: "https://auri-preview.trycloudflare.com", pid: 222 } });

  const html = renderActivePanel(state);
  assert.match(html, /<h2>System <em>auri-host<\/em><\/h2>/);
  assert.doesNotMatch(html, /<small>MONITOR<\/small><h2>System/);
  assert.match(html, /Network<\/small><strong>0\.50 \| 1\.00 MB\/s<\/strong>/);
  assert.match(html, /Swap<\/small><strong>50%<\/strong><span>1\.00 GB \/ 2\.00 GB<\/span>/);
  assert.match(html, /2\.00 MB/);
  assert.match(html, /Net up \| down/);
  assert.doesNotMatch(html, /Net ↓/);
  assert.doesNotMatch(html, /system-network-card/);
  assert.doesNotMatch(html, /Process monitor/);
  assert.doesNotMatch(html, /120 shown/);
  assert.doesNotMatch(html, /PID 10 · web/);
  assert.doesNotMatch(html, /Host<\/small>/);
  assert.match(html, /class="system-process-detail-backdrop"/);
  assert.ok(html.includes('display:flex'));
  assert.ok(html.includes('background:transparent'));
  assert.ok(html.includes('pointer-events:none'));
  assert.ok(html.includes('width:min(680px,calc(100% - 28px))'));
  assert.ok(html.includes('grid-template-columns:repeat(4,minmax(0,1fr))'));
  assert.match(html, /role="dialog"[^>]*aria-modal="true"[^>]*aria-label="Process detail"/);
  assert.match(html, /data-action="system-process-copy-value"[^>]*data-value="10"/);
  assert.match(html, /data-action="system-process-copy-value"[^>]*data-value="\/usr\/bin\/web --serve very-long-project"/);
  assert.doesNotMatch(html, /system-process-detail-close/);
  assert.doesNotMatch(html, /class="process-detail-stat is-pid"/);
  assert.match(html, /class="process-detail-header"[\s\S]*<strong[^>]*>web<\/strong>[\s\S]*PID <code[^>]*>10<\/code>[\s\S]*data-action="system-process-copy-value"[^>]*data-value="10"/);
  assert.match(html, /class="process-detail-stat-row"[\s\S]*<small>CPU<\/small>[\s\S]*1\.0%[\s\S]*<small>RAM<\/small><span[^>]*>MB<\/span>[\s\S]*Memory[\s\S]*2\.00[\s\S]*<small>Net<\/small><span[^>]*>MB<\/span>[\s\S]*Upload[\s\S]*0\.50[\s\S]*Download[\s\S]*1\.00[\s\S]*<small>Disk<\/small><span[^>]*>MB<\/span>[\s\S]*Read[\s\S]*0\.20[\s\S]*Write[\s\S]*0\.10/);
  assert.match(html, /<textarea class="process-detail-path-field"[^>]*readonly[^>]*rows="5"[^>]*>\/usr\/bin\/web --serve very-long-project<\/textarea>/);
  assert.match(html, /class="process-detail-ports"[\s\S]*<small[^>]*>Ports<\/small>/);
  assert.match(html, /class="process-detail-port-row"[\s\S]*<code[^>]*>3000<\/code>[\s\S]*data-action="system-process-tunnel-toggle"[^>]*data-port="3000"[\s\S]*Enable HTTPS tunnel/);
  assert.match(html, /<code[^>]*>5173<\/code>[\s\S]*data-action="system-process-tunnel-copy-url"[^>]*data-value="https:\/\/auri-preview\.trycloudflare\.com"[\s\S]*auri-preview\.trycloudflare\.com[\s\S]*data-action="system-process-tunnel-toggle"[^>]*data-port="5173"[\s\S]*Stop tunnel/);
  assert.match(html, /data-action="system-process-kill"/);
  assert.match(html, /data-action="system-process-open-path"/);
  assert.match(html, /process-row\s+is-selected/);
});



test("process table name column is wide enough and columns are ordered for scanning", () => {
  let state = createInitialState();
  state = { ...state, tabs: [{ ...state.tabs[0], activeSubtabId: "system-tab", subtabs: [...state.tabs[0].subtabs, { id: "system-tab", type: "system", title: "System" }] }] };
  state = reduceState(state, {
    type: "SYSTEM_SNAPSHOT_SET",
    payload: { snapshot: normalizeSystemSnapshot({ processes: [{ pid: 10, name: "web", memoryBytes: 2_000_000, cpuPercent: 1, downloadBytes: 1_000_000, uploadBytes: 500_000, ports: [3000, 17078] }] }) }
  });

  const html = renderActivePanel(state);
  assert.match(html, /Name[\s\S]*Port[\s\S]*RAM[\s\S]*CPU[\s\S]*Net up \| down[\s\S]*PID/);
  assert.match(html, /data-action="system-sort" data-sort="ram"/);
  assert.match(html, /data-action="system-sort" data-sort="port"/);
  assert.match(html, /data-action="system-sort" data-sort="cpu"/);
  assert.match(html, /title="web">web<\/span>[\s\S]*<code[^>]*>3000<\/code> <code>17078<\/code>[\s\S]*2\.00MB[\s\S]*1\.0%[\s\S]*0\.50 MB \| 1\.00 MB[\s\S]*<code>10<\/code>/);

  const css = readFileSync("styles.css", "utf8");
  assert.match(css, /\.process-row\s*\{[^}]*grid-template-columns:\s*minmax\(240px, 3fr\) minmax\(110px, 0.8fr\) 8ch 60px minmax\(130px, 1fr\) 62px/s);
  assert.match(css, /\.process-row\.is-disk\s*\{[^}]*grid-template-columns:\s*minmax\(240px, 3fr\) minmax\(110px, 0.8fr\) 8ch 60px minmax\(130px, 1fr\) 62px/s);
  assert.match(css, /\.process-row > span:nth-child\(3\)\s*\{[^}]*padding-left:\s*4px;[^}]*padding-right:\s*4px/s);
  assert.ok(css.indexOf(".process-row > span {") < css.indexOf(".process-row > span:nth-child(3)"), "RAM cell override must come after the generic cell rule");
  assert.match(css, /\.process-row > span:first-child\s*\{[^}]*padding-left:\s*10px/s);
  assert.match(css, /\.system-panel\s*\{[^}]*position:\s*relative/s);
  assert.match(css, /\.system-process-detail-backdrop\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center/s);
  assert.ok(css.includes('background: transparent'));
  assert.ok(css.includes('pointer-events: none'));
  assert.ok(css.includes('width: min(680px, calc(100% - 28px))'));
  assert.ok(css.includes('max-height: min(430px, calc(100% - 28px))'));
  assert.ok(css.includes('grid-template-columns: repeat(4, minmax(0, 1fr))'));
  assert.ok(css.includes('height: 74px'));
  assert.ok(css.includes('font: 500 11px/14px'));
  assert.ok(css.includes('.system-process-detail .icon-copy-button { width: 24px'));
  assert.match(css, /\.process-detail-stat-row\s*\{[^}]*grid-template-columns:\s*repeat\(4,/s);
  assert.match(css, /\.process-detail-header\s*\{[^}]*display:\s*flex/s);
  assert.match(css, /\.process-detail-path-field\s*\{[^}]*resize:\s*none;[^}]*overflow:\s*auto/s);
  assert.match(css, /\.process-detail-ports\s*\{[^}]*display:\s*grid/s);
  assert.match(css, /\.process-detail-port-row\s*\{[^}]*grid-template-columns:\s*auto 1fr auto/s);
});

test("disk and net subtabs render beside the system monitor", () => {
  let state = createInitialState();
  const tab = state.tabs[0];
  const diskSubtab = { id: "disk-tab", type: "disk", title: "Disk" };
  const netSubtab = { id: "net-tab", type: "net", title: "Net" };
  state = {
    ...state,
    tabs: [{ ...tab, activeSubtabId: "disk-tab", subtabs: [...tab.subtabs, { id: "system-tab", type: "system", title: "System" }, diskSubtab, netSubtab] }],
    system: {
      ...state.system,
      snapshot: normalizeSystemSnapshot({
        disk: { totalBytes: 10_000_000, usedBytes: 4_000_000, freeBytes: 6_000_000 },
        network: { interfaces: [{ name: "en0", ip: "192.168.0.2", status: "up", rxBytes: 1_000_000, txBytes: 2_000_000 }] },
        processes: [{ pid: 8, name: "server", ports: [8080], diskReadBytes: 1_000_000, diskWriteBytes: 2_000_000, downloadBytes: 3_000_000, uploadBytes: 4_000_000 }]
      })
    }
  };

  const tabs = renderSubtabs(state);
  assert.match(tabs, />System<\/span>/);
  assert.match(tabs, />Disk<\/span>/);
  assert.match(tabs, />Net<\/span>/);
  assert.match(renderActivePanel(state), /Disk monitor/);

  state = { ...state, tabs: [{ ...state.tabs[0], activeSubtabId: "net-tab" }] };
  const netHtml = renderActivePanel(state);
  assert.match(netHtml, /Network monitor/);
  assert.match(netHtml, /server/);
  assert.match(netHtml, /8080/);
});


test("process table scroll resets when the sort changes", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile("src/views/app-view.js", "utf8"));
  const sortCapture = source.indexOf('const processSortBy = state.system?.sortBy || "";');
  const resetDecision = source.indexOf("const resetProcessScroll =", sortCapture);
  const scrollCapture = source.indexOf("const processScrollTop = resetProcessScroll ? 0 : captureProcessScroll(this.root);", resetDecision);
  const replace = source.indexOf("this.root.innerHTML =", scrollCapture);
  const restore = source.indexOf("processTable.scrollTop = processScrollTop", replace);
  const remember = source.indexOf("this.lastProcessSortBy = processSortBy", restore);
  assert.ok(sortCapture >= 0, "process sort value must be tracked during render");
  assert.ok(resetDecision > sortCapture, "sort changes must decide whether process scroll resets before DOM replacement");
  assert.ok(scrollCapture > resetDecision && scrollCapture < replace, "process scroll must reset to top before replacing the DOM when sort changes");
  assert.ok(restore > replace, "process scroll must be restored after replacing the DOM");
  assert.ok(remember > restore, "the last process sort must be remembered after restoration");
});
