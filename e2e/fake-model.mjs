import { createServer } from "node:http";

const SLOW_HOLD_MS = 60_000;

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function lastUserImages(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message && message.role === "user") {
      return Array.isArray(message.content)
        ? message.content.filter((part) => part && part.type === "image_url").length
        : 0;
    }
  }
  return 0;
}

function lastUserText(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message && message.role === "user") return textOf(message.content);
  }
  return "";
}

function bulkAnswer(prompt) {
  const turn = prompt.match(/BULK (\d+)/)?.[1] ?? "0";
  const paragraphs = Array.from(
    { length: 12 },
    (_, index) =>
      `Bulk turn ${turn}, paragraph ${index + 1}: **bold**, _italic_, \`inline code\` and a [link](https://example.com/${index}).`,
  );
  const code = [
    "```ts",
    ...Array.from(
      { length: 30 },
      (_, index) => `const value${index} = compute(${index}, "turn ${turn}");`,
    ),
    "```",
  ];
  return [
    `# Bulk answer ${turn}`,
    "",
    ...paragraphs.flatMap((line) => [line, ""]),
    ...code,
    "",
    `- item one ${turn}`,
    "- item two",
    "",
    `Bulk end ${turn}`,
  ].join("\n");
}

/** The update line pi-ui put in context on start, for "WHATVERSION" prompts. */
function updateNotice(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    const text = message?.role === "user" ? textOf(message.content) : "";
    if (text.includes("<pi-ui-update>"))
      return text.split("\n").find((line) => line.startsWith("pi-ui ")) ?? "";
  }
  return "none";
}

function responseFor(prompt, body = {}) {
  if (prompt.includes("WHATVERSION")) return `Update notice: ${updateNotice(body)}`;
  if (prompt.includes("BULK")) return bulkAnswer(prompt);
  if (prompt.includes("LONG")) {
    return Array.from(
      { length: 40 },
      (_, index) =>
        `Paragraph ${index + 1} of a long answer. It keeps going so the reply is taller than the screen.`,
    ).join("\n\n");
  }
  if (prompt.includes("MARKDOWN")) {
    return [
      "# Markdown heading",
      "",
      "This is **bold** text and `inline code`.",
      "",
      "```ts",
      "const answer = 42;",
      "```",
      "",
      "[Example](https://example.com/docs)",
      "",
    ].join("\n");
  }
  return `Echo: ${prompt}`;
}

function chunkFor(text, finishReason = null, usage = undefined) {
  return {
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "e2e-model",
    choices: [
      {
        index: 0,
        delta: text.length > 0 ? { role: "assistant", content: text } : {},
        finish_reason: finishReason,
      },
    ],
    ...(usage === undefined ? {} : { usage }),
  };
}

function writeEvent(res, value) {
  res.write(`data: ${JSON.stringify(value)}\n\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

/** Bearer token the fake Hetzner API accepts; e2e/server.mjs exports it as HCLOUD_TOKEN. */
export const FAKE_HCLOUD_TOKEN = "e2e-hcloud-token-not-secret";
let hetznerHits = 0;

/** A tiny stand-in for `GET https://api.hetzner.cloud/v1/servers`. */
function hetznerServers(req, res) {
  if (req.headers.authorization !== `Bearer ${FAKE_HCLOUD_TOKEN}`) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "unauthorized", message: "unable to authenticate" } }));
    return;
  }
  hetznerHits += 1;
  const server = (id, name, status, type, gross) => ({
    id,
    name,
    status,
    public_net: { ipv4: { ip: `203.0.113.${id % 250}` } },
    server_type: {
      name: type,
      prices: [{ location: "fsn1", price_monthly: { net: gross, gross } }],
    },
    datacenter: { location: { name: "fsn1" } },
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      servers: [
        server(101, "web-1", "running", "cx22", "4.5900"),
        server(102, "db-1", "running", "cx32", "7.4900"),
        server(103, "worker-1", "off", "cx22", "4.5900"),
      ],
      meta: { pagination: { page: 1, per_page: 25, total_entries: 3 }, hits: hetznerHits },
    }),
  );
}

export function startFakeModelServer() {
  let origin = "";
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/hetzner/v1/servers")) {
      hetznerServers(req, res);
      return;
    }
    if (req.method === "GET" && req.url === "/hetzner/hits") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ hits: hetznerHits }));
      return;
    }
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }

    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad json" } }));
      return;
    }

    const prompt = lastUserText(body);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const last = messages.at(-1);
    // "JOBSTART <command>" calls job_start once; the tool result is then read back.
    const jobCommand = prompt.match(/^JOBSTART (.+)$/m)?.[1];
    // "TOOLCALLS [{"name":…,"arguments":{…}}, …]" makes those calls in one turn.
    // {{FAKE_HTTP}} in the JSON becomes this server's origin.
    const toolCalls = prompt.match(/^TOOLCALLS (.+)$/ms)?.[1];
    if (last?.role === "user" && toolCalls) {
      const calls = JSON.parse(toolCalls.replaceAll("{{FAKE_HTTP}}", origin));
      writeEvent(res, {
        id: "chatcmpl-e2e",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "e2e-model",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: calls.map((call, index) => ({
                index,
                id: `call_${Date.now()}_${index}`,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
              })),
            },
            finish_reason: null,
          },
        ],
      });
      writeEvent(res, chunkFor("", "tool_calls"));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    if (last?.role === "user" && jobCommand) {
      writeEvent(res, {
        id: "chatcmpl-e2e",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "e2e-model",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call_${Date.now()}`,
                  type: "function",
                  function: {
                    name: "job_start",
                    arguments: JSON.stringify({ command: jobCommand }),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      writeEvent(res, chunkFor("", "tool_calls"));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    if (last?.role === "tool") {
      const result = textOf(last.content).replace(/<acp[^>]*>[^<]*<\/acp>\n?/g, "");
      const reply = `Tool result: ${result.split("\n")[0]}`;
      for (const piece of reply.match(/.{1,18}/gs) ?? []) writeEvent(res, chunkFor(piece));
      writeEvent(res, chunkFor("", "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    if (prompt.includes("SLOW")) {
      writeEvent(res, chunkFor("Working on it"));
      const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 10_000);
      const stop = () => {
        clearInterval(heartbeat);
        res.end();
      };
      req.on("close", stop);
      setTimeout(stop, SLOW_HOLD_MS).unref();
      return;
    }

    const images = lastUserImages(body);
    const text =
      images > 0 ? `${responseFor(prompt, body)} [images: ${images}]` : responseFor(prompt, body);
    const bulk = prompt.includes("BULK");
    for (const piece of text.match(bulk ? /.{1,4000}/gs : /.{1,18}/gs) ?? []) {
      writeEvent(res, chunkFor(piece));
      if (!bulk) {
        await new Promise((resolve) => setTimeout(resolve, prompt.includes("LONGDRIP") ? 40 : 8));
      }
    }
    writeEvent(res, chunkFor("", "stop"));
    writeEvent(res, {
      id: "chatcmpl-e2e",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "e2e-model",
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 },
    });
    res.write("data: [DONE]\n\n");
    res.end();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("fake model server has no TCP address"));
        return;
      }
      origin = `http://127.0.0.1:${address.port}`;
      resolve({ server, port: address.port });
    });
  });
}
