import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const dataDir = path.join(root, "data");
const storePath = path.join(dataDir, "store.json");
const uploadDir = path.join(dataDir, "uploads");
const port = Number(process.env.PORT || 4173);
const maxJson = 1024 * 1024;
const maxUpload = 20 * 1024 * 1024;

fs.mkdirSync(uploadDir, { recursive: true });

const sessions = new Map();
const loginAttempts = new Map();
const feedbackHits = new Map();

function readStore() {
  return JSON.parse(fs.readFileSync(storePath, "utf8"));
}

function writeStore(store) {
  const temp = `${storePath}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(store, null, 2));
  fs.renameSync(temp, storePath);
}

function send(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
    "content-length": payload.length,
    ...headers,
  });
  res.end(payload);
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function sessionOf(req) {
  const id = readCookie(req, "sid");
  if (!id) return null;
  const row = sessions.get(id);
  if (!row) return null;
  if (Date.now() > row.expiresAt) {
    sessions.delete(id);
    return null;
  }
  return { id, ...row };
}

function setSessionCookie(res, id) {
  res.setHeader(
    "set-cookie",
    `sid=${encodeURIComponent(id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`,
  );
}

function clearSessionCookie(res) {
  res.setHeader("set-cookie", "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

function clientIp(req) {
  return req.socket.remoteAddress || "local";
}

function tooManyLogins(ip) {
  const now = Date.now();
  const row = loginAttempts.get(ip);
  if (!row || now > row.resetAt) return false;
  return row.count >= 8;
}

function markLoginFail(ip) {
  const now = Date.now();
  const row = loginAttempts.get(ip);
  if (!row || now > row.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000 });
    return;
  }
  row.count += 1;
}

function isLocalHost(req) {
  const host = String(req.headers.host || "").split(":")[0].replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function catalogFor(store, courseIds) {
  return courseIds
    .map((id) => store.courses[id])
    .filter(Boolean)
    .map((course) => ({
      courseId: course.courseId,
      label: course.label,
      portalLabel: course.portalLabel,
      accessCode: course.accessCode,
      startsAt: course.startsAt,
      contentRevision: course.revision,
    }));
}

function publicSession(store, session) {
  if (!session) {
    return { hasAccess: false, role: "visitor", catalog: [] };
  }
  return {
    hasAccess: true,
    role: session.role,
    code: session.code,
    courseIds: session.courseIds,
    catalog: catalogFor(store, session.courseIds),
  };
}

function canReadCourse(session, courseId) {
  return session && (session.role === "admin" || session.courseIds.includes(courseId));
}

function validId(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]*$/.test(value);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function fileAvailable(meta) {
  return Boolean(meta && fs.existsSync(path.join(uploadDir, meta.storedName)));
}

function channelView(store, courseId) {
  const messages = store.channels[courseId] || [];
  return {
    messages: messages.map((message) => {
      if (message.type !== "file") return message;
      const meta = store.files[message.file_id];
      return { ...message, available: fileAvailable(meta) };
    }),
  };
}

function contentTypeOf(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".json": "application/json; charset=utf-8",
  };
  return types[ext] || "application/octet-stream";
}

function serveStatic(req, res, url) {
  const rel = decodeURIComponent(url.pathname).replace(/^[/\\]+/, "");
  const filePath = path.resolve(publicDir, rel || "index.html");
  const rootWithSep = publicDir.endsWith(path.sep) ? publicDir : publicDir + path.sep;
  if (filePath !== publicDir && !filePath.startsWith(rootWithSep)) {
    sendText(res, 403, "forbidden");
    return;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    res.writeHead(200, { "content-type": contentTypeOf(filePath) });
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  fs.createReadStream(path.join(publicDir, "index.html")).pipe(res);
}

function headerValue(headerText, name) {
  const line = headerText
    .split(/\r\n/)
    .find((row) => row.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line ? line.slice(name.length + 1).trim() : "";
}

function filenameFromDisposition(value) {
  const star = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) return decodeURIComponent(star[1]);
  const plain = value.match(/filename="([^"]+)"/i) || value.match(/filename=([^;]+)/i);
  return plain ? plain[1].trim() : "upload.bin";
}

function parseMultipart(buffer, boundary) {
  const separator = Buffer.from(`--${boundary}`);
  const parts = [];
  let cursor = buffer.indexOf(separator);
  if (cursor < 0) return parts;
  cursor += separator.length;
  while (cursor < buffer.length) {
    if (buffer[cursor] === 45 && buffer[cursor + 1] === 45) break;
    if (buffer[cursor] === 13 && buffer[cursor + 1] === 10) cursor += 2;
    const next = buffer.indexOf(separator, cursor);
    const end = next < 0 ? buffer.length : next - 2;
    const chunk = buffer.subarray(cursor, end);
    const splitAt = chunk.indexOf(Buffer.from("\r\n\r\n"));
    if (splitAt >= 0) {
      parts.push({
        headers: chunk.subarray(0, splitAt).toString("utf8"),
        body: chunk.subarray(splitAt + 4),
      });
    }
    if (next < 0) break;
    cursor = next + separator.length;
  }
  return parts;
}

function createSession(res, code, entry) {
  const id = crypto.randomBytes(24).toString("hex");
  sessions.set(id, {
    role: entry.role,
    code,
    courseIds: entry.courseIds,
    expiresAt: Date.now() + 12 * 60 * 60 * 1000,
  });
  setSessionCookie(res, id);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (!url.pathname.startsWith("/api/")) {
      serveStatic(req, res, url);
      return;
    }

    const store = readStore();
    const session = sessionOf(req);

    if (req.method === "GET" && url.pathname === "/api/access/session") {
      send(res, 200, publicSession(store, session));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/access/login") {
      const ip = clientIp(req);
      if (tooManyLogins(ip)) {
        send(res, 429, { error: "嘗試次數過多，請稍後再試" });
        return;
      }
      const body = JSON.parse((await readBody(req, maxJson)).toString("utf8") || "{}");
      const code = String(body.code || "").trim();
      const key = code.toLowerCase();
      const entry = store.codes[key];
      if (!entry) {
        markLoginFail(ip);
        send(res, 401, { error: "代碼錯誤" });
        return;
      }
      loginAttempts.delete(ip);
      createSession(res, code, entry);
      send(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/access/logout") {
      if (session) sessions.delete(session.id);
      clearSessionCookie(res);
      send(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/access/local-admin") {
      if (!isLocalHost(req)) {
        send(res, 404, { error: "not found" });
        return;
      }
      if (req.method === "GET") {
        send(res, 200, { code: "teacher" });
        return;
      }
      if (req.method === "POST") {
        createSession(res, "teacher", store.codes.teacher);
        send(res, 200, { ok: true });
        return;
      }
    }

    const courseMatch = url.pathname.match(
      /^\/api\/courses\/([^/]+)(?:\/(content|channel|feedback)|\/files\/([^/]+)|\/channel\/upload)$/,
    );
    if (!courseMatch) {
      send(res, 404, { error: "not found" });
      return;
    }
    const courseId = decodeURIComponent(courseMatch[1]);
    const action = courseMatch[2] || (courseMatch[3] ? "file" : url.pathname.endsWith("/upload") ? "upload" : "");
    const fileId = courseMatch[3] ? decodeURIComponent(courseMatch[3]) : "";
    if (!validId(courseId) || !store.courses[courseId]) {
      send(res, 404, { error: "course not found" });
      return;
    }
    if (!canReadCourse(session, courseId)) {
      send(res, 401, { error: "unauthorized" });
      return;
    }

    if (req.method === "GET" && action === "content") {
      const course = store.courses[courseId];
      send(res, 200, {
        courseId,
        revision: course.revision,
        chapters: course.chapters,
        publishedAt: course.publishedAt,
      });
      return;
    }

    if (action === "channel" && req.method === "GET") {
      send(res, 200, channelView(store, courseId));
      return;
    }

    if (action === "upload" && req.method === "POST") {
      if (session.role !== "admin") {
        send(res, 403, { error: "forbidden" });
        return;
      }
      const contentType = req.headers["content-type"] || "";
      const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
      if (!boundaryMatch) {
        send(res, 400, { error: "expected multipart" });
        return;
      }
      const boundary = boundaryMatch[1] || boundaryMatch[2];
      const buffer = await readBody(req, maxUpload);
      const filePart = parseMultipart(buffer, boundary).find((part) =>
        /name="file"/i.test(headerValue(part.headers, "content-disposition")),
      );
      if (!filePart || filePart.body.length === 0) {
        send(res, 400, { error: "missing file" });
        return;
      }
      const disposition = headerValue(filePart.headers, "content-disposition");
      const name = filenameFromDisposition(disposition).slice(0, 180);
      const mime = headerValue(filePart.headers, "content-type") || "application/octet-stream";
      const id = crypto.randomUUID();
      const storedName = `${id}${path.extname(name).slice(0, 12)}`;
      fs.writeFileSync(path.join(uploadDir, storedName), filePart.body);
      store.files[id] = { name, mime, storedName };
      writeStore(store);
      send(res, 200, { id, name, mime });
      return;
    }

    if (action === "channel" && req.method === "POST") {
      if (session.role !== "admin") {
        send(res, 403, { error: "forbidden" });
        return;
      }
      const body = JSON.parse((await readBody(req, maxJson)).toString("utf8") || "{}");
      const message = {
        id: crypto.randomUUID(),
        pinned: false,
        createdAt: new Date().toISOString(),
      };
      if (body.type === "file") {
        const meta = store.files[body.file_id];
        if (!meta) {
          send(res, 400, { error: "unknown file" });
          return;
        }
        Object.assign(message, {
          type: "file",
          content: null,
          file_id: body.file_id,
          file_name: meta.name,
          file_mime: meta.mime,
        });
      } else {
        const content = String(body.content || "").trim();
        if (!content) {
          send(res, 400, { error: "empty" });
          return;
        }
        const isLink = /^https?:\/\/\S+$/i.test(content);
        Object.assign(message, { type: isLink ? "link" : "text", content });
      }
      store.channels[courseId] = store.channels[courseId] || [];
      store.channels[courseId].push(message);
      writeStore(store);
      send(res, 200, { ok: true, message });
      return;
    }

    if (action === "channel" && (req.method === "PATCH" || req.method === "DELETE")) {
      if (session.role !== "admin") {
        send(res, 403, { error: "forbidden" });
        return;
      }
      const messageId = url.searchParams.get("id");
      const list = store.channels[courseId] || [];
      const index = list.findIndex((item) => item.id === messageId);
      if (index < 0) {
        send(res, 404, { error: "message not found" });
        return;
      }
      if (req.method === "DELETE") {
        list.splice(index, 1);
      } else {
        const body = JSON.parse((await readBody(req, maxJson)).toString("utf8") || "{}");
        list[index].pinned = Boolean(body.pinned);
      }
      writeStore(store);
      send(res, 200, { ok: true });
      return;
    }

    if (action === "file" && req.method === "GET") {
      const meta = store.files[fileId];
      const filePath = meta ? path.join(uploadDir, meta.storedName) : "";
      if (!meta || !filePath.startsWith(uploadDir) || !fs.existsSync(filePath)) {
        send(res, 404, { error: "檔案不在本機" });
        return;
      }
      res.writeHead(200, {
        "content-type": meta.mime || "application/octet-stream",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    if (action === "feedback" && req.method === "POST") {
      const hitKey = `${session.id}:${courseId}`;
      const last = feedbackHits.get(hitKey) || 0;
      if (Date.now() - last < 30 * 1000) {
        send(res, 429, { error: "提交太頻繁，請稍後再試" });
        return;
      }
      const body = JSON.parse((await readBody(req, maxJson)).toString("utf8") || "{}");
      const comment = String(body.comment || "").trim();
      if (!comment || comment.length > 2000) {
        send(res, 400, { error: "請寫一些內容再送出" });
        return;
      }
      store.feedback[courseId] = store.feedback[courseId] || [];
      store.feedback[courseId].push({
        id: crypto.randomUUID(),
        comment,
        createdAt: new Date().toISOString(),
      });
      writeStore(store);
      feedbackHits.set(hitKey, Date.now());
      send(res, 200, { ok: true });
      return;
    }

    if (action === "feedback" && req.method === "GET") {
      if (session.role !== "admin") {
        send(res, 403, { error: "forbidden" });
        return;
      }
      send(res, 200, { items: store.feedback[courseId] || [] });
      return;
    }

    if (action === "feedback" && req.method === "DELETE") {
      if (session.role !== "admin") {
        send(res, 403, { error: "forbidden" });
        return;
      }
      const itemId = url.searchParams.get("id");
      store.feedback[courseId] = (store.feedback[courseId] || []).filter((item) => item.id !== itemId);
      writeStore(store);
      send(res, 200, { ok: true });
      return;
    }

    send(res, 405, { error: "method not allowed" });
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    send(res, status, { error: status === 413 ? "檔案太大" : "系統連線暫時不穩，請稍後再試" });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`student-mode http://127.0.0.1:${port}`);
});
