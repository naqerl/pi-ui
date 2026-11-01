// The e2e app under test is a small pool of independent servers. The runner
// starts one app command per target, but the browser suite shares that app
// across every worker/file unless each browser session is routed to its own
// state. A per-session shard keeps DATA_DIR, the conversation, tasks, jobs and
// MCP registries isolated while the suite runs files in parallel.
//
// The first request from a browser context is assigned a sticky shard cookie;
// every later request from that context (including SSE reconnects) is proxied
// to the same backend. Node-side requests without a cookie get their own shard
// too, so they never mutate a browser test's state by accident.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, request } from "node:http";
import { createServer as createNetServer } from "node:net";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SHARD_COOKIE = "pi_e2e_shard";
const root = fileURLToPath(new URL("..", import.meta.url));
const backendEntry = fileURLToPath(new URL("./backend.mjs", import.meta.url));
const port = Number(process.env.PORT || 8787);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}
const cpuCount = Math.max(1, availableParallelism());
const defaultShards = Math.max(4, cpuCount * 2);
const requestedShards = Number(process.env.PI_E2E_SHARDS ?? defaultShards);
const initialShards = Number.isInteger(requestedShards)
  ? Math.min(64, Math.max(1, requestedShards))
  : defaultShards;
// Under heavy load a wide, dynamic shard pool multiplies backend boot races.
// Keep the pool bounded by the machine, with only a little room for overlapping
// browser contexts.
const MAX_SHARDS = Math.min(64, initialShards + Math.ceil(cpuCount / 2));
// A newly leased shard stays out of the pool long enough for its first document
// and EventSource to arrive; an open SSE stream keeps it leased until it closes.
const LEASE_MS = 15_000;
const IDLE_GRACE_MS = 1_000;

let clock = 0;
const shards = Array.from({ length: initialShards }, (_, id) => ({
  id,
  child: null,
  port: null,
  ready: null,
  dataDir: null,
  log: "",
  lastUsed: -id,
  leasedUntil: 0,
  streams: 0,
  used: false,
}));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("the port probe has no TCP address"));
        return;
      }
      const value = address.port;
      probe.close((error) => (error === undefined ? resolve(value) : reject(error)));
    });
  });
}

function appendLog(shard, chunk) {
  shard.log = `${shard.log}${chunk.toString()}`.slice(-20_000);
}

async function waitForHealth(shard) {
  const url = `http://127.0.0.1:${shard.port}/api/health`;
  const deadline = Date.now() + 240_000;
  let delay = 250;
  while (Date.now() < deadline) {
    if (shard.child?.exitCode !== null && shard.child?.exitCode !== undefined) {
      throw new Error(`shard ${shard.id} exited before it answered\n${shard.log}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return;
    } catch {
      // The backend is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(1_000, delay * 2);
  }
  throw new Error(`shard ${shard.id} did not answer within 240 seconds\n${shard.log}`);
}

function startShard(shard) {
  shard.dataDir = mkdtempSync(join(tmpdir(), `pi-ui-e2e-shard-${shard.id}-`));
  return (async () => {
    shard.port = await freePort();
    const child = spawn(process.execPath, ["--import", "tsx", backendEntry], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(shard.port),
        PI_E2E_DATA_DIR: shard.dataDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    shard.child = child;
    child.stdout?.on("data", (chunk) => appendLog(shard, chunk));
    child.stderr?.on("data", (chunk) => appendLog(shard, chunk));
    child.on("exit", () => {
      // A dead shard gets a fresh backend on its next request.
      if (!shuttingDown) {
        shard.child = null;
        shard.port = null;
        shard.ready = null;
      }
    });
    await waitForHealth(shard);
    return shard;
  })();
}

function ensureShard(shard) {
  if (shard.ready !== null) return shard.ready;
  shard.ready = startShard(shard).catch((error) => {
    shard.ready = null;
    throw error;
  });
  return shard.ready;
}

/**
 * A new browser context gets a clean backend: the shard's previous DATA_DIR is
 * removed and a fresh process started. This keeps tests in different files from
 * inheriting each other's conversation, dashboard, tasks, jobs or MCP registry.
 */
async function restartShard(shard) {
  if (shard.ready === null && shard.child === null) return;
  const child = shard.child;
  if (child !== null && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }
  if (shard.dataDir !== null) {
    try {
      rmSync(shard.dataDir, { recursive: true, force: true });
    } catch {
      // Best effort; a leftover temp dir is harmless.
    }
  }
  shard.child = null;
  shard.port = null;
  shard.ready = null;
  shard.dataDir = null;
  shard.log = "";
}

/** Boots a shard, first clearing any state the previous browser session left. */
async function prepareShard(shard, fresh) {
  if (fresh && shard.used) await restartShard(shard);
  shard.used = true;
  return ensureShard(shard);
}

function cookieShard(header) {
  const match = new RegExp(`(?:^|;\\s*)${SHARD_COOKIE}=(\\d+)`).exec(header ?? "");
  if (match === null) return undefined;
  const id = Number(match[1]);
  return shards[id];
}

function assignShard(reserve) {
  const now = Date.now();
  let chosen;
  for (const shard of shards) {
    if (shard.streams > 0 || shard.leasedUntil > now) continue;
    if (chosen === undefined || shard.lastUsed < chosen.lastUsed) chosen = shard;
  }
  if (chosen === undefined) {
    if (shards.length < MAX_SHARDS) {
      chosen = {
        id: shards.length,
        child: null,
        port: null,
        ready: null,
        dataDir: null,
        log: "",
        lastUsed: -shards.length,
        leasedUntil: 0,
        streams: 0,
        used: false,
      };
      shards.push(chosen);
    } else {
      // More live sessions than the cap allows (not expected at these worker
      // counts): share the quietest shard rather than fail the run outright.
      chosen = shards.toSorted((a, b) => a.streams - b.streams || a.lastUsed - b.lastUsed)[0];
    }
  }
  if (reserve) chosen.leasedUntil = now + LEASE_MS;
  return chosen;
}

async function proxyTo(shard, req, res, newCookie, fresh) {
  await prepareShard(shard, fresh);
  if (shard.port === null) throw new Error(`shard ${shard.id} has no port`);
  const headers = { ...req.headers, host: `127.0.0.1:${shard.port}` };
  const upstream = request(
    {
      host: "127.0.0.1",
      port: shard.port,
      method: req.method,
      path: req.url,
      headers,
    },
    (response) => {
      const responseHeaders = { ...response.headers };
      if (newCookie !== undefined) {
        const cookies = responseHeaders["set-cookie"] ?? [];
        responseHeaders["set-cookie"] = [...cookies, newCookie];
      }
      res.writeHead(response.statusCode ?? 502, responseHeaders);
      res.flushHeaders();
      response.pipe(res);
      response.on("error", () => res.destroy());
    },
  );
  upstream.on("error", (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=UTF-8" });
      res.end(`e2e shard ${shard.id} unavailable: ${String(error)}\n`);
    } else {
      res.destroy(error);
    }
  });
  req.on("aborted", () => upstream.destroy());
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
}

const server = createHttpServer((req, res) => {
  const existing = cookieShard(req.headers.cookie);
  const document = req.method === "GET" && (req.headers.accept ?? "").includes("text/html");
  const shard = existing ?? assignShard(document);
  const newCookie =
    existing === undefined
      ? `${SHARD_COOKIE}=${shard.id}; Path=/; SameSite=Lax; Max-Age=86400`
      : undefined;
  if (req.url?.startsWith("/api/stream")) shard.streams += 1;
  shard.lastUsed = ++clock;
  // A cookie-less health/state probe must not lock a shard; a browser that has
  // the cookie keeps it leased even if its EventSource is briefly absent.
  if (existing !== undefined)
    shard.leasedUntil = Math.max(shard.leasedUntil, Date.now() + LEASE_MS);
  res.on("close", () => {
    if (req.url?.startsWith("/api/stream") && shard.streams > 0) {
      shard.streams -= 1;
      if (shard.streams === 0) shard.leasedUntil = Date.now() + IDLE_GRACE_MS;
    }
  });
  proxyTo(shard, req, res, newCookie, existing === undefined && document).catch((error) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=UTF-8" });
      res.end(`e2e proxy failed: ${String(error)}\n`);
    } else {
      res.destroy(error);
    }
  });
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const shard of shards) {
    try {
      shard.child?.kill("SIGKILL");
    } catch {
      // The child already left.
    }
    if (shard.dataDir !== null) {
      try {
        rmSync(shard.dataDir, { recursive: true, force: true });
      } catch {
        // Best effort; a leftover temp dir is harmless.
      }
    }
  }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.on("connection", (socket) => socket.setNoDelay(true));
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actual = address !== null && typeof address !== "string" ? address.port : port;
  console.log(`pi-ui e2e proxy listening on http://127.0.0.1:${actual} (${initialShards} shards)`);
});
