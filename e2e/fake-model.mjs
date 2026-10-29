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

function responseFor(prompt) {
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

export function startFakeModelServer() {
  const server = createServer(async (req, res) => {
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
    const text = images > 0 ? `${responseFor(prompt)} [images: ${images}]` : responseFor(prompt);
    for (const piece of text.match(/.{1,18}/gs) ?? []) {
      writeEvent(res, chunkFor(piece));
      await new Promise((resolve) => setTimeout(resolve, 8));
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
      resolve({ server, port: address.port });
    });
  });
}
