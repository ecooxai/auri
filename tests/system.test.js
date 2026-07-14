import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SYSTEM_PROCESS_PAGE_SIZE, attachProcessNetworkRates, filterSystemProcesses, matchesProcessSearch, normalizeSystemSnapshot, primaryProcessPort, protocolForPort, sortSystemProcesses } from "../src/model/system.js";
import { renderActivePanel, renderSubtabs, renderSystemKillPrompt } from "../src/views/panels.js";
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


test("process CPU sorting puts the highest CPU user first even without ports", () => {
  const sorted = sortSystemProcesses([
    { pid: 1, name: "busy", cpuPercent: 90, memoryBytes: 1_000, ports: [] },
    { pid: 2, name: "web", cpuPercent: 5, memoryBytes: 1_000, ports: [8080] },
    { pid: 3, name: "api", cpuPercent: 8, memoryBytes: 1_000, ports: [3000] }
  ], "cpu");

  assert.deepEqual(sorted.map((item) => item.pid), [1, 3, 2]);
});

test("process sorting supports combined network traffic", () => {
  const sorted = sortSystemProcesses([
    { pid: 1, name: "quiet", downloadBytes: 9, uploadBytes: 1 },
    { pid: 2, name: "loud", downloadBytes: 50, uploadBytes: 50 },
    { pid: 3, name: "upload", downloadBytes: 0, uploadBytes: 70 }
  ], "net");

  assert.deepEqual(sorted.map((item) => item.pid), [2, 3, 1]);
});


test("process sorting supports combined disk activity", () => {
  const sorted = sortSystemProcesses([
    { pid: 1, name: "quiet", diskReadBytes: 5, diskWriteBytes: 5 },
    { pid: 2, name: "writer", diskReadBytes: 0, diskWriteBytes: 50 },
    { pid: 3, name: "reader", diskReadBytes: 80, diskWriteBytes: 0 }
  ], "disk");
  assert.deepEqual(sorted.map((item) => item.pid), [3, 2, 1]);
});

test("system process list renders one 10-row page, sorts the full dataset, and replaces rows on next page", () => {
  let state = createInitialState();
  const systemTab = state.tabs[0].subtabs.find((item) => item.type === "system");
  state = { ...state, tabs: [{ ...state.tabs[0], activeSubtabId: systemTab.id }] };
  const processes = Array.from({ length: 32 }, (_, index) => ({
    pid: index + 1,
    name: `process-${index + 1}`,
    cpuPercent: index === 31 ? 999 : index,
    memoryBytes: index
  }));
  state = reduceState(state, { type: "SYSTEM_SNAPSHOT_SET", payload: { snapshot: normalizeSystemSnapshot({ processes }) } });

  let html = renderActivePanel(state);
  assert.equal(SYSTEM_PROCESS_PAGE_SIZE, 10);
  assert.equal((html.match(/data-process-row=/g) || []).length, SYSTEM_PROCESS_PAGE_SIZE);
  assert.match(html, /data-process-row="32"/, "sorting must happen before selecting page one");
  assert.match(html, /data-system-page>Page 1 \/ 4<\/span>/);
  assert.match(html, /data-action="system-process-page-prev"[^>]*disabled[^>]*>&lt;<\/button>/);
  assert.match(html, /data-action="system-process-page-next"[^>]*>&gt;<\/button>/);
  assert.match(html, /data-has-previous="false"/);
  assert.match(html, /data-has-next="true"/);

  state = reduceState(state, { type: "SYSTEM_PROCESS_PAGE_NEXT" });
  html = renderActivePanel(state);
  assert.equal((html.match(/data-process-row=/g) || []).length, SYSTEM_PROCESS_PAGE_SIZE);
  assert.doesNotMatch(html, /data-process-row="32"/, "page two replaces page one instead of appending it");
  assert.match(html, /data-process-row="22"/);
  assert.match(html, /data-system-page>Page 2 \/ 4<\/span>/);
  assert.match(html, /data-action="system-process-page-prev"[^>]*>&lt;<\/button>/);
  assert.match(html, /data-has-previous="true"/);

  state = reduceState(state, { type: "SYSTEM_PROCESS_PAGE_PREVIOUS" });
  html = renderActivePanel(state);
  assert.equal(state.system.processPage, 1);
  assert.match(html, /data-process-row="32"/);
});

test("system refresh preserves the current process page and clamps it only when the result set shrinks", () => {
  let state = createInitialState();
  const makeSnapshot = (count) => normalizeSystemSnapshot({
    capturedAt: new Date(2026, 0, count).toISOString(),
    processes: Array.from({ length: count }, (_, index) => ({ pid: index + 1, name: `process-${index + 1}`, cpuPercent: count - index }))
  });
  state = reduceState(state, { type: "SYSTEM_SNAPSHOT_SET", payload: { snapshot: makeSnapshot(25) } });
  state = reduceState(state, { type: "SYSTEM_PROCESS_PAGE_NEXT" });
  assert.equal(state.system.processPage, 2);

  state = reduceState(state, { type: "SYSTEM_SNAPSHOT_SET", payload: { snapshot: makeSnapshot(25) } });
  assert.equal(state.system.processPage, 2, "refresh keeps the current page");

  state = reduceState(state, { type: "SYSTEM_SNAPSHOT_SET", payload: { snapshot: makeSnapshot(12) } });
  assert.equal(state.system.processPage, 2, "page two remains valid after a smaller refresh");

  state = reduceState(state, { type: "SYSTEM_SNAPSHOT_SET", payload: { snapshot: makeSnapshot(5) } });
  assert.equal(state.system.processPage, 1, "refresh clamps an invalid page to the last available page");
});

test("system search filters the full process dataset before paging and resets to page one", () => {
  let state = createInitialState();
  const systemTab = state.tabs[0].subtabs.find((item) => item.type === "system");
  state = { ...state, tabs: [{ ...state.tabs[0], activeSubtabId: systemTab.id }] };
  const processes = Array.from({ length: 30 }, (_, index) => ({
    pid: index + 1,
    name: index === 27 ? "needle-worker" : `process-${index + 1}`,
    cpuPercent: 30 - index
  }));
  state = reduceState(state, { type: "SYSTEM_SNAPSHOT_SET", payload: { snapshot: normalizeSystemSnapshot({ processes }) } });
  state = reduceState(state, { type: "SYSTEM_PROCESS_PAGE_NEXT" });
  state = reduceState(state, { type: "SYSTEM_FILTER_SET", payload: { filter: "needle" } });

  const html = renderActivePanel(state);
  assert.equal(state.system.processPage, 1, "typing a new filter resets paging");
  assert.match(html, /data-process-row="28"/);
  assert.equal((html.match(/data-process-row=/g) || []).length, 1);
  assert.match(html, /data-system-page>Page 1 \/ 1<\/span>/);
});

test("protocolForPort maps common tcp and udp ports to their protocol", () => {
  assert.equal(protocolForPort(80, "tcp"), "http");
  assert.equal(protocolForPort(8080, "tcp"), "http");
  assert.equal(protocolForPort(443, "tcp"), "https");
  assert.equal(protocolForPort(22, "tcp"), "ssh");
  assert.equal(protocolForPort(21, "tcp"), "ftp");
  assert.equal(protocolForPort(5432, "tcp"), "postgres");
  assert.equal(protocolForPort(53, "udp"), "dns");
  assert.equal(protocolForPort(51999, "tcp"), "");
});

test("matchesProcessSearch is a vague, case-insensitive substring match", () => {
  const chrome = { name: "Google Chrome Helper", commandLine: "/Applications/Chrome.app", path: "", ports: [] };
  assert.equal(matchesProcessSearch(chrome, ""), true, "empty query matches everything");
  assert.equal(matchesProcessSearch(chrome, "chrome"), true);
  assert.equal(matchesProcessSearch(chrome, "CHROME"), true);
  assert.equal(matchesProcessSearch(chrome, "helper"), true);
  assert.equal(matchesProcessSearch(chrome, "safari"), false);
});

test("matchesProcessSearch treats spaces as OR across multiple keywords", () => {
  const chrome = { name: "Google Chrome", ports: [] };
  const claude = { name: "Claude", ports: [] };
  const safari = { name: "Safari", ports: [] };
  assert.equal(matchesProcessSearch(chrome, "chrome claude"), true);
  assert.equal(matchesProcessSearch(claude, "chrome claude"), true);
  assert.equal(matchesProcessSearch(safari, "chrome claude"), false);
});

test("matchesProcessSearch also searches port numbers and pid", () => {
  const web = { name: "web", ports: [8080], pid: 4312 };
  assert.equal(matchesProcessSearch(web, "8080"), true);
  assert.equal(matchesProcessSearch(web, "4312"), true);
});

test("filterSystemProcesses returns all processes matching any keyword", () => {
  const processes = [
    { pid: 1, name: "Google Chrome", ports: [] },
    { pid: 2, name: "Claude", ports: [] },
    { pid: 3, name: "Safari", ports: [] }
  ];
  assert.deepEqual(filterSystemProcesses(processes, "chrome claude").map((item) => item.pid), [1, 2]);
  assert.deepEqual(filterSystemProcesses(processes, "").map((item) => item.pid), [1, 2, 3]);
});

test("snapshot normalization derives structured portDetails with transport and protocol", () => {
  const snapshot = normalizeSystemSnapshot({
    processes: [
      { pid: 5, name: "web", ports: [80, 443] },
      { pid: 6, name: "dns", portDetails: [{ port: 53, transport: "udp" }] }
    ]
  });
  assert.deepEqual(snapshot.processes[0].ports, [80, 443]);
  assert.deepEqual(snapshot.processes[0].portDetails, [
    { port: 80, transport: "tcp", protocol: "http" },
    { port: 443, transport: "tcp", protocol: "https" }
  ]);
  assert.deepEqual(snapshot.processes[1].portDetails, [{ port: 53, transport: "udp", protocol: "dns" }]);
  assert.deepEqual(snapshot.processes[1].ports, [53]);
});

test("attachProcessNetworkRates derives per-process throughput from consecutive snapshots", () => {
  const previous = { capturedAt: "2026-01-01T00:00:00.000Z", processes: [{ pid: 5, downloadBytes: 1_000_000, uploadBytes: 500_000 }] };
  const current = { capturedAt: "2026-01-01T00:00:05.000Z", processes: [{ pid: 5, downloadBytes: 6_000_000, uploadBytes: 500_000 }] };
  const result = attachProcessNetworkRates(current, previous);
  assert.equal(result.processes[0].downloadBytesPerSecond, 1_000_000);
  assert.equal(result.processes[0].uploadBytesPerSecond, 0);
});

test("attachProcessNetworkRates yields zero rates without a usable previous snapshot", () => {
  const current = { capturedAt: "2026-01-01T00:00:05.000Z", processes: [{ pid: 5, downloadBytes: 6_000_000, uploadBytes: 500_000 }] };
  assert.equal(attachProcessNetworkRates(current, null).processes[0].downloadBytesPerSecond, 0);
});

test("SYSTEM_SNAPSHOT_SET computes process network rates against the prior snapshot", () => {
  let state = createInitialState();
  state = reduceState(state, { type: "SYSTEM_SNAPSHOT_SET", payload: { snapshot: normalizeSystemSnapshot({ capturedAt: "2026-01-01T00:00:00.000Z", processes: [{ pid: 5, name: "web", downloadBytes: 1_000_000, uploadBytes: 0 }] }) } });
  assert.equal(state.system.snapshot.processes[0].downloadBytesPerSecond, 0);
  state = reduceState(state, { type: "SYSTEM_SNAPSHOT_SET", payload: { snapshot: normalizeSystemSnapshot({ capturedAt: "2026-01-01T00:00:05.000Z", processes: [{ pid: 5, name: "web", downloadBytes: 6_000_000, uploadBytes: 0 }] }) } });
  assert.equal(state.system.snapshot.processes[0].downloadBytesPerSecond, 1_000_000);
});

test("system state records the process search filter", () => {
  let state = createInitialState();
  assert.equal(state.system.filter, "");
  state = reduceState(state, { type: "SYSTEM_FILTER_SET", payload: { filter: "  Chrome  " } });
  assert.equal(state.system.filter, "Chrome");
  state = reduceState(state, { type: "SYSTEM_FILTER_SET", payload: { filter: "" } });
  assert.equal(state.system.filter, "");
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
  assert.match(html, /<h2>System <span class="system-page-controls"[^>]*>[\s\S]*data-system-page>Page 1 \/ 1<\/span>[\s\S]*<em data-system-host>auri-host<\/em><\/h2>/);
  assert.doesNotMatch(html, /<small>MONITOR<\/small><h2>System/);
  assert.match(html, /Net<span class="system-metric-unit" data-metric-unit>MB\/s<\/span><\/small><strong data-metric-value>↓ 1\.00  ↑ 0\.50<\/strong><span data-metric-detail>download · upload<\/span>/);
  assert.match(html, /Memory<span class="system-metric-unit" data-metric-unit>MB<\/span><\/small><strong data-metric-value>50%<\/strong><span data-metric-detail>1\.00 \/ 2\.00<\/span>/);
  assert.match(html, /Swap<span class="system-metric-unit" data-metric-unit>GB<\/span><\/small><strong data-metric-value>50%<\/strong><span data-metric-detail>1\.00 \/ 2\.00<\/span>/);
  assert.match(html, /data-sort="net"[^>]*>Net<\/button>/);
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
  assert.match(html, /data-action="system-process-detail-close"[^>]*aria-label="Close process detail"/);
  assert.doesNotMatch(html, /class="process-detail-stat is-pid"/);
  assert.match(html, /class="process-detail-header"[\s\S]*<strong[^>]*>web<\/strong>[\s\S]*PID <code[^>]*>10<\/code>[\s\S]*data-action="system-process-copy-value"[^>]*data-value="10"/);
  // The copy icon sits immediately right of the PID, and open-path/kill are
  // icon buttons at the top of the detail header instead of a footer.
  const headerHtml = html.slice(html.indexOf('class="process-detail-header"'), html.indexOf('class="process-detail-stat-row"'));
  assert.match(headerHtml, /data-action="system-process-copy-value"[^>]*data-value="10"[^>]*aria-label="Copy process PID"/);
  assert.match(headerHtml, /data-action="system-process-open-path"[^>]*aria-label="Open process path"/);
  assert.match(headerHtml, /data-action="system-process-kill"[^>]*aria-label="Kill process"/);
  assert.ok(headerHtml.indexOf('data-action="system-process-copy-value"') < headerHtml.indexOf('data-action="system-process-open-path"'));
  assert.doesNotMatch(html, /<footer>[\s\S]*data-action="system-process-kill"/);
  assert.doesNotMatch(html, /Kill process<\/button>/);
  assert.match(html, /class="process-detail-stat-row"[\s\S]*<small>CPU<\/small>[\s\S]*1\.0%[\s\S]*<small>RAM<\/small><span[^>]*>MB<\/span>[\s\S]*2\.00[\s\S]*<small>Net<\/small><span[^>]*>MB<\/span>[\s\S]*↓[\s\S]*1\.00[\s\S]*↑[\s\S]*0\.50[\s\S]*<small>Disk<\/small><span[^>]*>MB<\/span>[\s\S]*Read[\s\S]*0\.20[\s\S]*Write[\s\S]*0\.10/);
  // The RAM value renders as a single large number; the truncated "Mem…"
  // label row is gone since the MB unit already sits in the card head.
  assert.doesNotMatch(html, /<b>Memory<\/b>/);
  assert.match(html, /<textarea class="process-detail-path-field"[^>]*readonly[^>]*rows="5"[^>]*>\/usr\/bin\/web --serve very-long-project<\/textarea>/);
  assert.match(html, /class="process-detail-ports"[\s\S]*<small[^>]*>Ports<\/small>/);
  assert.match(html, /class="process-detail-port-row"[\s\S]*<code[^>]*>3000<\/code>[\s\S]*data-action="system-process-tunnel-toggle"[^>]*data-port="3000"[\s\S]*Enable HTTPS tunnel/);
  assert.match(html, /<code[^>]*>5173<\/code>[\s\S]*data-action="system-process-tunnel-url-menu-toggle"[^>]*data-port="5173"[^>]*data-value="https:\/\/auri-preview\.trycloudflare\.com"[\s\S]*auri-preview\.trycloudflare\.com[\s\S]*data-action="system-process-tunnel-open"[^>]*data-value="https:\/\/auri-preview\.trycloudflare\.com"[\s\S]*data-action="system-process-tunnel-toggle"[^>]*data-port="5173"[\s\S]*Stop tunnel/);
  assert.match(html, /data-action="system-process-kill"/);
  assert.match(html, /data-action="system-process-open-path"/);
  assert.match(html, /process-row\s+is-selected/);
});



function selectedProcessState() {
  let state = createInitialState();
  state = { ...state, tabs: [{ ...state.tabs[0], activeSubtabId: "system-tab", subtabs: [...state.tabs[0].subtabs, { id: "system-tab", type: "system", title: "System" }] }] };
  state = reduceState(state, {
    type: "SYSTEM_SNAPSHOT_SET",
    payload: { snapshot: normalizeSystemSnapshot({ processes: [
      { pid: 42, name: "WindowServer", path: "/usr/bin/ws", commandLine: "/usr/bin/ws", memoryBytes: 1_000_000, cpuPercent: 3 }
    ] }) }
  });
  return reduceState(state, { type: "SYSTEM_PROCESS_SELECT", payload: { pid: 42 } });
}

test("process detail uses a Kill text button plus a distinct close button", () => {
  const html = renderActivePanel(selectedProcessState());
  const headerHtml = html.slice(html.indexOf('class="process-detail-header"'), html.indexOf('class="process-detail-stat-row"'));
  // Kill is now a labelled text button rather than an ✕ icon.
  assert.match(headerHtml, /class="process-detail-kill"[^>]*data-action="system-process-kill"[^>]*>Kill<\/button>/);
  // A separate close button hides the card without killing anything.
  assert.match(headerHtml, /class="icon-copy-button process-detail-close"[^>]*data-action="system-process-detail-close"[^>]*aria-label="Close process detail"/);
  assert.ok(headerHtml.indexOf('data-action="system-process-kill"') < headerHtml.indexOf('data-action="system-process-detail-close"'));
});

test("kill confirmation prompt renders only when armed and names the process and pid", () => {
  const armed = reduceState(selectedProcessState(), { type: "UI_SET", payload: { systemKillPrompt: { pid: 42, name: "WindowServer" } } });
  assert.equal(renderSystemKillPrompt(selectedProcessState()), "");
  const html = renderSystemKillPrompt(armed);
  assert.match(html, /class="system-tunnel-prompt-backdrop system-kill-prompt-backdrop"[^>]*data-action="system-kill-prompt-cancel"/);
  assert.match(html, /role="dialog"[^>]*aria-modal="true"[^>]*aria-label="Confirm kill process"/);
  assert.match(html, /Kill WindowServer\?/);
  assert.match(html, /PID 42/);
  assert.match(html, /data-action="system-kill-prompt-cancel">Cancel</);
  assert.match(html, /data-action="system-kill-prompt-confirm">Kill process</);
});

test("selecting or closing another process clears a stale kill prompt", () => {
  const armed = reduceState(selectedProcessState(), { type: "UI_SET", payload: { systemKillPrompt: { pid: 42, name: "WindowServer" } } });
  const closed = reduceState(armed, { type: "SYSTEM_PROCESS_SELECT", payload: { pid: null } });
  assert.equal(closed.ui.systemKillPrompt, null);
  // Re-selecting the same pid keeps whatever prompt is showing.
  const same = reduceState(armed, { type: "SYSTEM_PROCESS_SELECT", payload: { pid: 42 } });
  assert.deepEqual(same.ui.systemKillPrompt, { pid: 42, name: "WindowServer" });
});

test("system search bar renders when open and filters the process list by keyword", () => {
  let state = createInitialState();
  state = { ...state, tabs: [{ ...state.tabs[0], activeSubtabId: "system-tab", subtabs: [...state.tabs[0].subtabs, { id: "system-tab", type: "system", title: "System" }] }] };
  state = reduceState(state, {
    type: "SYSTEM_SNAPSHOT_SET",
    payload: { snapshot: normalizeSystemSnapshot({ processes: [
      { pid: 1, name: "Google Chrome", cpuPercent: 5 },
      { pid: 2, name: "Claude", cpuPercent: 4 },
      { pid: 3, name: "Safari", cpuPercent: 3 }
    ] }) }
  });

  assert.match(renderActivePanel(state), /data-action="system-search-toggle"/);
  assert.doesNotMatch(renderActivePanel(state), /id="system-search-input"/);

  state = reduceState(state, { type: "UI_SET", payload: { systemSearchOpen: true } });
  state = reduceState(state, { type: "SYSTEM_FILTER_SET", payload: { filter: "chrome claude" } });
  const html = renderActivePanel(state);
  assert.match(html, /id="system-search-input"[^>]*value="chrome claude"/);
  assert.match(html, /data-process-row="1"/);
  assert.match(html, /data-process-row="2"/);
  assert.doesNotMatch(html, /data-process-row="3"/);
});

test("process table name column is wide enough and columns are ordered for scanning", () => {
  let state = createInitialState();
  state = { ...state, tabs: [{ ...state.tabs[0], activeSubtabId: "system-tab", subtabs: [...state.tabs[0].subtabs, { id: "system-tab", type: "system", title: "System" }] }] };
  state = reduceState(state, {
    type: "SYSTEM_SNAPSHOT_SET",
    payload: { snapshot: normalizeSystemSnapshot({ processes: [{ pid: 10, name: "web", memoryBytes: 2_000_000, cpuPercent: 1, downloadBytes: 1_000_000, uploadBytes: 500_000, ports: [3000, 17078] }] }) }
  });

  const html = renderActivePanel(state);
  assert.match(html, /Name[\s\S]*Port[\s\S]*RAM[\s\S]*CPU[\s\S]*>Net<[\s\S]*PID/);
  assert.match(html, /data-action="system-sort" data-sort="ram"/);
  assert.match(html, /data-action="system-sort" data-sort="port"/);
  assert.match(html, /data-action="system-sort" data-sort="cpu"/);
  assert.match(html, /title="web">web<\/span>[\s\S]*<code[^>]*>3000<span[^>]*>http<\/span><\/code> <code[^>]*>17078<span[^>]*>tcp<\/span><\/code>[\s\S]*2\.00MB[\s\S]*1\.0%[\s\S]*↓ 0\.00MB  ↑ 0\.00MB[\s\S]*<code>10<\/code>/);

  const css = readFileSync("styles.css", "utf8");
  assert.match(css, /\.process-row\s*\{[^}]*grid-template-columns:\s*minmax\(140px, 1.5fr\) minmax\(130px, 1.6fr\) 8ch 60px minmax\(150px, 1.7fr\) 62px/s);
  assert.match(css, /\.process-row\.is-disk\s*\{[^}]*grid-template-columns:\s*minmax\(140px, 1.5fr\) minmax\(130px, 1.6fr\) 8ch 60px minmax\(150px, 1.7fr\) 62px/s);
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
  assert.match(tabs, /aria-label="System tab menu"/);
  assert.match(tabs, />Disk<\/span>/);
  assert.match(tabs, />Net<\/span>/);
  const diskHtml = renderActivePanel(state);
  assert.match(diskHtml, /Disk monitor/);
  assert.match(diskHtml, /data-action="system-sort" data-sort="disk"/);

  state = { ...state, tabs: [{ ...state.tabs[0], activeSubtabId: "net-tab" }] };
  const netHtml = renderActivePanel(state);
  assert.match(netHtml, /Network monitor/);
  assert.match(netHtml, /server/);
  assert.match(netHtml, /8080/);
});


test("AppView.patchSystemMonitor updates the open system panel in place", async () => {
  const { AppView } = await import("../src/views/app-view.js");

  function fakeNode(children = {}) {
    return {
      textContent: "",
      hidden: false,
      scrollTop: 0,
      innerHTML: "",
      toggled: {},
      classList: {
        toggle(name, on) {}
      },
      querySelector(selector) { return children[selector] || null; },
      insertAdjacentHTML(_, html) { this.appendedHtml = (this.appendedHtml || "") + html; },
      remove() { this.removed = true; }
    };
  }

  const metricKeys = ["cpu", "memory", "network", "disk", "swap", "uptime"];
  const tiles = {};
  const tileParts = {};
  for (const key of metricKeys) {
    const value = fakeNode();
    const detail = fakeNode();
    tileParts[key] = { value, detail };
    tiles[`[data-metric="${key}"]`] = fakeNode({ "[data-metric-value]": value, "[data-metric-detail]": detail });
  }
  const statusEl = fakeNode();
  const hostEl = fakeNode();
  const pageEl = fakeNode();
  pageEl.textContent = "Page 9 / 9";
  const table = fakeNode();
  table.scrollTop = 40;
  const monitor = fakeNode({ ".process-table": table });
  const panel = fakeNode({
    ...tiles,
    "[data-system-status]": statusEl,
    "[data-system-host]": hostEl,
    "[data-system-page]": pageEl,
    ".process-monitor": monitor
  });
  const root = { querySelector: (selector) => (selector === ".system-panel" ? panel : null) };

  let state = createInitialState();
  const systemTab = state.tabs[0].subtabs.find((item) => item.type === "system");
  state = reduceState(state, { type: "SUBTAB_SELECT", payload: { id: systemTab.id } });
  state = reduceState(state, {
    type: "SYSTEM_SNAPSHOT_SET",
    payload: {
      snapshot: normalizeSystemSnapshot({
        capturedAt: "2026-01-01T00:00:00.000Z",
        host: { hostname: "auri-host", uptimeSeconds: 3600 },
        cpu: { brand: "Test CPU", cores: 8, usagePercent: 7 },
        memory: { totalBytes: 2_000_000, usedBytes: 1_000_000 },
        network: { interfaces: [], totalRxBytes: 1, totalTxBytes: 1 },
        processes: [{ pid: 77, name: "node", cpuPercent: 1, memoryBytes: 10 }]
      })
    }
  });

  const view = new AppView(root);
  assert.equal(view.patchSystemMonitor(state), true);
  assert.equal(tileParts.cpu.value.textContent, "7.0%");
  assert.match(statusEl.textContent, /Updated/);
  assert.equal(hostEl.textContent, "auri-host");
  assert.equal(pageEl.textContent, "Page 1 / 1");
  assert.match(monitor.innerHTML, /process-row/);
  assert.match(monitor.innerHTML, /77/);
  assert.equal(table.scrollTop, 40);
});

test("AppView.patchSystemMonitor reports failure when the panel is missing so callers fall back to a full render", async () => {
  const { AppView } = await import("../src/views/app-view.js");
  const view = new AppView({ querySelector: () => null });
  assert.equal(view.patchSystemMonitor(createInitialState()), false);
});

test("AppView.patchProcessRows updates process metrics in place", async () => {
  const { AppView } = await import("../src/views/app-view.js");
  const { buildProcessMonitorRows } = await import("../src/views/panels.js");

  function cell(text = "") {
    return { textContent: text, innerHTML: text, title: "", classList: { toggle() {} } };
  }

  const nameCell = cell("node");
  const portCell = cell("");
  const ramCell = cell("10MB");
  const cpuCell = cell("1.0%");
  const netCell = cell("0.00 | 0.00 MB");
  const row = {
    classList: { toggle() {} },
    querySelector(selector) {
      if (selector === "[data-process-name]") return nameCell;
      if (selector === "[data-process-port]") return portCell;
      if (selector === "[data-process-ram]") return ramCell;
      if (selector === "[data-process-cpu]") return cpuCell;
      if (selector === "[data-process-net]") return netCell;
      return null;
    }
  };
  const table = {
    querySelector(selector) {
      return selector === `[data-process-row="77"]` ? row : null;
    },
    querySelectorAll(selector) {
      return selector === "[data-process-row]" ? [row] : [];
    }
  };
  const countLabel = cell("1 shown");
  const monitor = {
    querySelector(selector) {
      if (selector === ".process-table") return table;
      if (selector === ".process-monitor-head span:last-child") return countLabel;
      return null;
    }
  };

  let state = createInitialState();
  state = reduceState(state, {
    type: "SYSTEM_SNAPSHOT_SET",
    payload: {
      snapshot: normalizeSystemSnapshot({
        processes: [{ pid: 77, name: "node", cpuPercent: 9, memoryBytes: 20_000_000, ports: [8080] }]
      })
    }
  });

  const view = new AppView({ querySelector: () => null });
  const rows = buildProcessMonitorRows(state, "system");
  assert.equal(view.patchProcessRows(monitor, rows), true);
  assert.equal(cpuCell.textContent, "9.0%");
  assert.match(portCell.innerHTML, /8080/);
  assert.equal(countLabel.textContent, "1 on page");
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
