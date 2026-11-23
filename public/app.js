const app = document.querySelector("#app");
const siteBase = new URL("./", import.meta.url);
const PAGES = location.hostname.endsWith("github.io");
const PAGE_SESSION = "pages-session";
const PAGE_OVERLAY = "pages-overlay";
let pageData = null;
let pageFeedbackAt = 0;
const texts = new Map();
const state = {
  view: "loading",
  session: null,
  loadMessage: "正在確認登入狀態...",
  code: "",
  showCode: false,
  loginError: "",
  loginBusy: false,
  localBusy: false,
  localError: "",
  isLocal: ["localhost", "127.0.0.1", "::1"].includes(location.hostname),
  courseId: "",
  content: null,
  messages: [],
  feedbackItems: [],
  comment: "",
  feedbackBusy: false,
  feedbackError: "",
  feedbackDone: false,
  draft: "",
  composer: { kind: "idle", text: "" },
  dragging: false,
  modal: null,
};

let channelTimer = 0;
let feedbackTimer = 0;

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function remember(text) {
  const id = `t${texts.size + 1}`;
  texts.set(id, text);
  return id;
}

function safeUrl(value) {
  try {
    const url = new URL(value, location.origin);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  } catch {
    return "";
  }
  return "";
}

function showHome() {
  history.replaceState(null, "", siteBase.pathname);
}

function readOverlay() {
  try {
    return JSON.parse(localStorage.getItem(PAGE_OVERLAY)) || {};
  } catch {
    return {};
  }
}

function pageError(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function pageCatalog(courseIds) {
  return courseIds.map((id) => pageData.courses[id]).filter(Boolean).map((course) => ({
    courseId: course.courseId,
    label: course.label,
    portalLabel: course.portalLabel,
    accessCode: course.accessCode,
    startsAt: course.startsAt,
    contentRevision: course.revision,
  }));
}

function pageSession() {
  try {
    return JSON.parse(sessionStorage.getItem(PAGE_SESSION));
  } catch {
    return null;
  }
}

function pageMessages(courseId) {
  const saved = readOverlay().channels?.[courseId];
  const list = saved || pageData.channels[courseId] || [];
  return list.map((message) => {
    if (message.type !== "file") return message;
    return { ...message, available: Boolean(pageData.files[message.file_id]?.storedName) };
  });
}

function withPageList(bucket, courseId, change) {
  const extra = readOverlay();
  extra[bucket] = extra[bucket] || {};
  if (!extra[bucket][courseId]) {
    const source = bucket === "channels" ? pageData.channels[courseId] : pageData.feedback[courseId];
    extra[bucket][courseId] = JSON.parse(JSON.stringify(source || []));
  }
  change(extra[bucket][courseId]);
  localStorage.setItem(PAGE_OVERLAY, JSON.stringify(extra));
}

async function pagesApi(path, options = {}) {
  const url = new URL(path, "https://pages.local");
  const method = (options.method || "GET").toUpperCase();
  const body = typeof options.body === "string" ? JSON.parse(options.body || "{}") : {};
  if (url.pathname === "/api/access/session") {
    const session = pageSession();
    if (!session) return { hasAccess: false, role: "visitor", catalog: [] };
    return {
      hasAccess: true,
      role: session.role,
      code: session.code,
      courseIds: session.courseIds,
      catalog: pageCatalog(session.courseIds),
    };
  }
  if (url.pathname === "/api/access/login" && method === "POST") {
    const code = String(body.code || "").trim();
    const entry = pageData.codes[code.toLowerCase()];
    if (!entry) pageError(401, "代碼錯誤");
    sessionStorage.setItem(PAGE_SESSION, JSON.stringify({ role: entry.role, code, courseIds: entry.courseIds }));
    return { ok: true };
  }
  if (url.pathname === "/api/access/logout") {
    sessionStorage.removeItem(PAGE_SESSION);
    return { ok: true };
  }
  const match = url.pathname.match(/^\/api\/courses\/([^/]+)\/(content|channel|feedback|channel\/upload)$/);
  if (!match) pageError(404, "not found");
  const courseId = decodeURIComponent(match[1]);
  const action = match[2];
  const session = pageSession();
  if (!session?.courseIds?.includes(courseId)) pageError(401, "unauthorized");
  if (action === "content" && method === "GET") {
    const course = pageData.courses[courseId];
    return { courseId, revision: course.revision, chapters: course.chapters, publishedAt: course.publishedAt };
  }
  if (action === "channel" && method === "GET") return { messages: pageMessages(courseId) };
  if (action === "channel/upload") pageError(400, "GitHub Pages 不能保存新上傳的檔案");
  if (action === "channel" && method === "POST") {
    if (session.role !== "admin") pageError(403, "forbidden");
    if (body.type === "file") pageError(400, "GitHub Pages 不能保存新上傳的檔案");
    const content = String(body.content || "").trim();
    if (!content) pageError(400, "empty");
    withPageList("channels", courseId, (list) => {
      list.push({
        id: crypto.randomUUID(),
        pinned: false,
        createdAt: new Date().toISOString(),
        type: /^https?:\/\/\S+$/i.test(content) ? "link" : "text",
        content,
      });
    });
    return { ok: true };
  }
  if (action === "channel" && (method === "PATCH" || method === "DELETE")) {
    if (session.role !== "admin") pageError(403, "forbidden");
    const messageId = url.searchParams.get("id");
    withPageList("channels", courseId, (list) => {
      const index = list.findIndex((item) => item.id === messageId);
      if (index < 0) return;
      if (method === "DELETE") list.splice(index, 1);
      else list[index].pinned = Boolean(body.pinned);
    });
    return { ok: true };
  }
  if (action === "feedback" && method === "GET") {
    if (session.role !== "admin") pageError(403, "forbidden");
    return { items: readOverlay().feedback?.[courseId] || pageData.feedback[courseId] || [] };
  }
  if (action === "feedback" && method === "POST") {
    if (Date.now() - pageFeedbackAt < 30000) pageError(429, "提交太頻繁，請稍後再試");
    const comment = String(body.comment || "").trim();
    if (!comment || comment.length > 2000) pageError(400, "請寫一些內容再送出");
    withPageList("feedback", courseId, (list) => {
      list.push({ id: crypto.randomUUID(), comment, createdAt: new Date().toISOString() });
    });
    pageFeedbackAt = Date.now();
    return { ok: true };
  }
  if (action === "feedback" && method === "DELETE") {
    if (session.role !== "admin") pageError(403, "forbidden");
    const itemId = url.searchParams.get("id");
    withPageList("feedback", courseId, (list) => {
      const index = list.findIndex((item) => item.id === itemId);
      if (index >= 0) list.splice(index, 1);
    });
    return { ok: true };
  }
  pageError(405, "method not allowed");
}

async function api(path, options = {}) {
  if (PAGES) return pagesApi(path, options);
  const response = await fetch(path, { cache: "no-store", ...options });
  const isJson = (response.headers.get("content-type") || "").includes("json");
  const body = isJson ? await response.json().catch(() => ({})) : null;
  if (!response.ok) {
    const error = new Error(body?.error || `請求失敗 ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function taipeiParts(iso) {
  const parts = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const pick = (type) => parts.find((part) => part.type === type)?.value || "";
  return {
    date: `${pick("month")}/${pick("day")}`,
    week: pick("weekday"),
    time: `${pick("hour")}:${pick("minute")}`,
    hour: Number(pick("hour")),
  };
}

function formatClock(iso) {
  const parts = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(iso));
  const dayPeriod = parts.find((part) => part.type === "dayPeriod")?.value || "";
  const hour = parts.find((part) => part.type === "hour")?.value || "";
  const minute = parts.find((part) => part.type === "minute")?.value || "";
  return `${dayPeriod}${hour}:${minute}`;
}

function formatStamp(iso) {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function sameTaipeiDay(iso) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const that = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
  return today === that;
}

function eyeIcon(open) {
  if (open) {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3l18 18"/><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.9 5.1A10.8 10.8 0 0 1 12 5c7 0 10 7 10 7a18 18 0 0 1-3.2 4.2"/><path d="M6.1 6.1C3.8 7.8 2 12 2 12s3 7 10 7a10 10 0 0 0 4.1-.9"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
}

function courseOf(courseId) {
  return state.session?.catalog?.find((course) => course.courseId === courseId) || null;
}

function stopPolls() {
  clearInterval(channelTimer);
  clearInterval(feedbackTimer);
  channelTimer = 0;
  feedbackTimer = 0;
}

function paint() {
  texts.clear();
  if (state.view === "loading") app.innerHTML = loadingHtml();
  else if (state.view === "login") app.innerHTML = loginHtml();
  else if (state.view === "list") app.innerHTML = listHtml();
  else app.innerHTML = courseHtml();
  const code = document.querySelector("#code");
  if (code) code.value = state.code;
  const draft = document.querySelector("#composer");
  if (draft) draft.value = state.draft;
  const comment = document.querySelector("#fb-comment");
  if (comment) comment.value = state.comment;
}

function loadingHtml() {
  return `<div class="student-loading-page"><section class="student-loading" role="status" aria-live="polite">
    <div class="student-loading__status"><span class="student-loading__beacon"></span><span>${esc(state.loadMessage)}</span></div>
    <div class="student-loading__skeleton" aria-hidden="true">
      <div class="student-loading__heading"><span class="student-loading__block student-loading__block--badge"></span><span class="student-loading__block student-loading__block--title"></span></div>
      <div class="student-loading__rule"></div>
      <div class="student-loading__card"><span class="student-loading__block student-loading__block--card-title"></span><span class="student-loading__block student-loading__block--line"></span><span class="student-loading__block student-loading__block--line-short"></span></div>
    </div>
  </section></div>`;
}

function loginHtml() {
  const origin = siteBase.href;
  const qr = `https://api.qrserver.com/v1/create-qr-code/?size=232x232&margin=12&data=${encodeURIComponent(origin)}`;
  return `<section class="course-entry" aria-labelledby="course-entry-title">
    <div class="course-entry__content">
      <div class="course-entry__shell">
        <header class="course-entry__header">
          <p class="course-entry__brand">學員上課課程系統</p>
          <h1 id="course-entry-title">在電腦開啟今天的課程</h1>
          <p>手機用來記錄入口；實際課程請回到電腦開啟並登入。</p>
        </header>
        <div class="course-entry__layout">
          <section class="course-entry__ticket" aria-labelledby="course-entry-qr-title">
            <div class="course-entry__ticket-heading"><span>課程入口</span><h2 id="course-entry-qr-title">拍照或掃描留存</h2></div>
            <div class="course-entry__qr" aria-label="課程入口 QR Code"><img alt="學員上課課程系統 QR Code" src="${qr}" /></div>
            <div class="course-entry__address"><span>直接輸入網址</span><strong>${esc(origin)}</strong></div>
            <p class="course-entry__ticket-note">手機只用來保留入口，實際課程請在電腦操作。</p>
          </section>
          <ol class="course-entry__journey" aria-label="進入課程步驟">
            <li class="course-entry__step"><span class="course-entry__marker" aria-hidden="true">1</span><div class="course-entry__step-content"><h2>拍下這個畫面</h2><p>用手機保留 QR Code 與完整網址。</p></div></li>
            <li class="course-entry__step"><span class="course-entry__marker" aria-hidden="true">2</span><div class="course-entry__step-content"><h2>掃描取得網址</h2><p>用手機相機掃描左側 QR Code，確認完整網址。</p></div></li>
            <li class="course-entry__step"><span class="course-entry__marker" aria-hidden="true">3</span><div class="course-entry__step-content"><h2>回到電腦貼上網址</h2><p>在電腦瀏覽器貼上 <span class="course-entry__inline-url">${esc(origin)}</span></p></div></li>
            <li class="course-entry__step course-entry__step--login">
              <span class="course-entry__marker" aria-hidden="true">4</span>
              <div class="course-entry__step-content">
                <h2>輸入代碼，開始上課</h2>
                <p>輸入老師提供的課程或管理代碼。</p>
                <div class="course-entry__form">
                  <div class="course-entry__input-wrap">
                    <input id="code" class="course-entry__input" type="${state.showCode ? "text" : "password"}" placeholder="輸入代碼" aria-label="登入代碼" ${state.loginBusy ? "disabled" : ""} />
                    <button type="button" class="course-entry__visibility" data-action="toggle-code" aria-label="${state.showCode ? "隱藏代碼" : "顯示代碼"}" ${state.loginBusy ? "disabled" : ""}>${eyeIcon(state.showCode)}</button>
                  </div>
                  <button type="button" class="course-entry__button${state.loginBusy ? " course-entry__button--loading" : ""}" data-action="login" ${state.loginBusy || !state.code ? "disabled" : ""}>
                    ${state.loginBusy ? `<span class="course-entry__button-spinner" aria-hidden="true"></span>驗證中...` : "登入"}
                  </button>
                </div>
                ${state.loginError ? `<p class="course-entry__error" role="alert">${esc(state.loginError)}</p>` : ""}
              </div>
            </li>
          </ol>
        </div>
      </div>
      ${state.isLocal ? `<div class="course-entry__local-admin">
        <button type="button" class="course-entry__local-button" data-action="local-admin" ${state.localBusy ? "disabled" : ""}>${state.localBusy ? "正在進入…" : "進入後臺"}</button>
        ${state.localError ? `<p class="course-entry__local-error" role="alert">${esc(state.localError)}</p>` : ""}
      </div>` : ""}
    </div>
  </section>`;
}

function listHtml() {
  const catalog = state.session?.catalog || [];
  const upcoming = catalog.filter((course) => sameTaipeiDay(course.startsAt) || Date.parse(course.startsAt) >= Date.now() - 12 * 60 * 60 * 1000);
  const rows = (upcoming.length ? upcoming : catalog).map((course) => {
    const when = taipeiParts(course.startsAt);
    const today = sameTaipeiDay(course.startsAt);
    return `<li class="course-row${today ? " is-next" : ""}">
      <button type="button" class="course-row__open" data-action="open-course" data-course="${esc(course.courseId)}">
        <span class="course-row__date"><span class="course-row__date-day">${esc(when.date)}</span><span class="course-row__date-week">${esc(when.week)}</span></span>
        <span class="course-row__main">
          <span class="course-row__eyebrow"><span class="course-row__time">${esc(when.time)}</span></span>
          <span class="course-row__title">${esc(course.portalLabel)}</span>
          <span class="course-row__meta">${esc(course.label)}</span>
        </span>
        <span class="course-row__status${today ? " course-row__status--today" : ""}">${today ? "今天" : "即將開課"}</span>
        <svg class="course-row__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>
      </button>
      <div class="course-row__password"><span class="course-row__password-label">課程代碼</span><code>${esc(course.accessCode)}</code>
        <button type="button" class="course-row__copy" data-action="copy" data-text-id="${remember(course.accessCode)}">複製</button>
      </div>
    </li>`;
  }).join("");
  return `<div class="admin-session-bar" aria-label="管理操作"><span></span><button type="button" class="admin-session-bar__button" data-action="logout">登出</button></div>
    <main class="sp-page sp-page--admin"><div class="course-groups">
      <div class="course-groups__header"><h1 class="course-groups__title">課程清單</h1><p class="course-groups__desc">選擇要進入的課程。學員用課程代碼登入後，會直接看到該堂課。</p></div>
      <div class="course-groups__section"><p class="course-groups__section-label">即將開課</p>
        ${rows ? `<ul class="course-groups__rows">${rows}</ul>` : `<p class="course-groups__empty">目前沒有即將開課的課程。</p>`}
      </div>
    </div></main>`;
}

function itemCategory(type) {
  if (["download", "docx", "skill", "text-download", "file-link"].includes(type)) return "asset";
  if (type === "demo") return "demo";
  if (type === "links" || type === "link-card") return "links";
  if (type === "note" || type === "field-map") return "note";
  if (type === "image") return "image";
  return "prompt";
}

const categoryLabel = {
  asset: "素材檔案",
  demo: "範例工具",
  prompt: "參考 Prompt",
  links: "相關連結",
  note: "重點筆記",
  image: "操作圖解",
};

function promptBox(item) {
  const id = remember(item.content);
  return `<div class="prompt-box"><div class="prompt-box__header"><span class="prompt-box__title">${esc(item.title)}</span><button type="button" class="prompt-box__copy" data-action="copy" data-text-id="${id}">複製</button></div><div class="prompt-box__body"><div class="prompt-box__content">${esc(item.content)}</div></div></div>`;
}

function skillCard(item) {
  const id = remember(item.content);
  return `<div class="download-card" data-action="copy" data-text-id="${id}"><div class="download-card__info"><p class="download-card__name">${esc(item.filename)}</p><p class="download-card__desc">${esc(item.desc || "")}</p></div><div class="download-card__actions"><button type="button" class="download-card__btn download-card__btn--preview" data-action="preview" data-text-id="${id}" data-title="${esc(item.filename)}">預覽</button><button type="button" class="download-card__btn" data-action="copy" data-text-id="${id}">複製</button></div></div>`;
}

function fileLinkCard(item) {
  const href = safeUrl(item.url);
  const pdf = item.filename.toLowerCase().endsWith(".pdf");
  return `<div class="download-card"><div class="download-card__info"><p class="download-card__name">${esc(item.filename)}</p><p class="download-card__desc">${esc(item.desc || "")}</p></div><div class="download-card__actions">${pdf ? `<button type="button" class="download-card__btn download-card__btn--preview" data-action="preview-url" data-url="${esc(href)}" data-title="${esc(item.filename)}">預覽</button>` : ""}<a class="download-card__btn" href="${esc(href)}" download="${esc(item.filename)}">下載</a></div></div>`;
}

function linkCard(item) {
  const href = safeUrl(item.url);
  return `<a class="download-card" href="${esc(href)}" target="_blank" rel="noreferrer noopener"><div class="download-card__info"><p class="download-card__name">${esc(item.filename)}</p><p class="download-card__desc">${esc(item.desc || "")}</p></div><div class="download-card__actions"><span class="download-card__btn">${esc(item.actionLabel || "開啟")}</span></div></a>`;
}

function renderItem(item) {
  if (item.type === "skill") return skillCard(item);
  if (item.type === "file-link") return fileLinkCard(item);
  if (item.type === "link-card") return linkCard(item);
  return promptBox(item);
}

function chaptersHtml(chapters) {
  return chapters.map((chapter) => {
    const groups = (chapter.subgroups || []).map((group) => {
      const categories = new Set((group.items || []).map((item) => itemCategory(item.type)));
      const showLabel = categories.size > 1;
      let last = "";
      const body = (group.items || []).map((item) => {
        const category = itemCategory(item.type);
        const label = showLabel && category !== last
          ? `<div class="sp-section-label">${categoryLabel[category]}</div>`
          : "";
        last = category;
        return label + renderItem(item);
      }).join("");
      return `<div class="subgroup">${group.title ? `<div class="subgroup-title">${esc(group.title)}</div>` : ""}${body}</div>`;
    }).join("");
    return `<section class="chapter"><h3 class="section-title"><span class="section-number">${esc(chapter.number)}</span><span class="section-title-text">${esc(chapter.title)}</span></h3>${groups}</section>`;
  }).join("");
}

function messageHtml(message) {
  const time = `<div class="msg__time">${esc(formatClock(message.createdAt))}</div>`;
  let body = "";
  if (message.type === "file") {
    const storedName = PAGES ? pageData?.files?.[message.file_id]?.storedName : "";
    const fileHref = storedName
      ? new URL(`files/${storedName}`, siteBase).href
      : `/api/courses/${encodeURIComponent(state.courseId)}/files/${encodeURIComponent(message.file_id)}`;
    body = message.available
      ? `<a class="msg__file" href="${fileHref}" download="${esc(message.file_name)}">${esc(message.file_name)}</a>`
      : `<a class="msg__file" href="${fileHref}" data-action="download-file" data-name="${esc(message.file_name)}">${esc(message.file_name)}</a><p class="msg__missing">這個檔案還沒有在本機。請用老師代碼登入後，在上課素材重新上傳。</p>`;
  } else if (message.type === "link") {
    const href = safeUrl(message.content);
    body = `<div class="msg__text"><a href="${esc(href)}" target="_blank" rel="noreferrer noopener">${esc(message.content)}</a></div>`;
  } else {
    const id = remember(message.content || "");
    body = `<div class="msg__row"><div class="msg__content"><div class="msg__text">${esc(message.content || "")}</div></div><div class="msg__actions"><button type="button" class="msg__action-btn" data-action="copy" data-text-id="${id}">複製</button></div></div>`;
  }
  const admin = state.session?.role === "admin"
    ? `<div class="msg__actions"><button type="button" class="msg__action-btn" data-action="pin" data-id="${esc(message.id)}" data-pinned="${message.pinned ? "1" : "0"}">${message.pinned ? "取消釘選" : "釘選"}</button><button type="button" class="msg__action-btn is-delete" data-action="ask-delete-message" data-id="${esc(message.id)}">刪除</button></div>`
    : "";
  return `<article class="msg${message.pinned ? " is-pinned" : ""}"><div class="msg__content">${body}${time}</div>${admin}</article>`;
}

function feedInner() {
  if (!state.messages.length) return `<div class="feed-empty">目前沒有任何訊息</div>`;
  return state.messages.map(messageHtml).join("");
}

function composerHtml() {
  if (state.session?.role !== "admin") return "";
  const status = state.composer.kind === "idle" ? "" : `<div class="composer__status composer__status--${esc(state.composer.kind)}">${state.composer.kind === "loading" ? `<span class="composer__spinner"></span>` : ""}${esc(state.composer.text)}</div>`;
  return `<div class="composer" id="composer-box">
    <textarea id="composer" class="composer__textarea${state.dragging ? " is-dragging" : ""}" rows="3" placeholder="輸入文字或貼上網址，Enter 送出，或拖入檔案上傳"></textarea>
    <p class="composer__hint">Enter 送出，Shift+Enter 換行。檔案也可以拖進來。</p>
    ${status}
    <input id="file-input" type="file" hidden />
  </div>`;
}

function feedbackHtml() {
  if (state.session?.role === "admin") {
    const items = state.feedbackItems.map((item) => `<article class="fb-admin-item"><div class="fb-admin-item__head"><time class="fb-admin-item__time">${esc(formatStamp(item.createdAt))}</time></div><p class="fb-admin-item__comment">${esc(item.comment)}</p><div class="fb-admin-item__actions"><button type="button" class="fb-admin-item__delete" data-action="ask-delete-feedback" data-id="${esc(item.id)}">刪除</button></div></article>`).join("");
    return `<section class="fb-admin"><h2 class="fb-title"><span class="fb-title__hash">#</span><span>回饋總覽（老師）</span></h2><div class="fb-admin-summary"><span>共 <strong id="fb-count">${state.feedbackItems.length}</strong> 筆回饋</span></div><div id="fb-admin-list">${state.feedbackItems.length ? `<div class="fb-admin-list">${items}</div>` : `<div class="fb-admin-empty">尚無學生回饋</div>`}</div></section>`;
  }
  if (state.feedbackDone) {
    return `<section class="fb"><h2 class="fb-title"><span class="fb-title__hash">#</span><span>課後回饋</span></h2><div class="fb-thanks">感謝你的回饋！<button type="button" class="fb-thanks__again" data-action="feedback-again">想再交一份回饋</button></div></section>`;
  }
  return `<section class="fb"><h2 class="fb-title"><span class="fb-title__hash">#</span><span>課後回饋</span></h2>
    <p class="fb-subtitle">回饋是匿名的，請放心填寫真實感受。</p>
    <div class="fb-form"><div class="fb-field"><p class="fb-hint-lead">你可以從這幾個方向想：</p><ul class="fb-hint-list"><li>哪個環節對你來說最有收穫</li><li>有哪一個地方講解並不是很清楚</li><li>如果可以，希望延伸往下學習什麼</li></ul>
    <textarea id="fb-comment" class="fb-textarea" maxlength="2000" rows="6" placeholder="寫下你今天的想法…"></textarea></div>
    <div class="fb-actions"><button type="button" class="fb-submit" data-action="send-feedback" ${state.feedbackBusy ? "disabled" : ""}>${state.feedbackBusy ? "送出中…" : "送出回饋"}</button></div>
    ${state.feedbackError ? `<div class="fb-status fb-status--error" role="alert">${esc(state.feedbackError)}</div>` : ""}</div></section>`;
}

function courseHtml() {
  const course = courseOf(state.courseId);
  const when = taipeiParts(course?.startsAt || Date.now());
  const admin = state.session?.role === "admin";
  const bar = admin
    ? `<div class="admin-session-bar" aria-label="管理操作"><button type="button" class="admin-session-bar__button" data-action="back-list">返回課程清單</button><button type="button" class="admin-session-bar__button" data-action="logout">登出</button></div>`
    : "";
  return `${bar}<main class="sp-page${admin ? " sp-page--admin" : ""}"><div class="${admin ? "" : "student-session-bar"}">${admin ? "" : `<button type="button" class="student-session-bar__button" data-action="logout">登出</button>`}</div>
    <div class="course-surface"><header class="course-surface__header"><span class="course-surface__date">${esc(when.date)}</span><h2 class="course-surface__title">${esc(course?.portalLabel || "課程")}</h2></header>
    <section id="channel" class="channel"><h3 class="channel-title"><span class="channel-title__hash">#</span><span>上課素材</span></h3>${composerHtml()}<div class="feed" id="feed">${feedInner()}</div></section>
    <div class="sp-root">${state.content ? chaptersHtml(state.content.chapters || []) : `<p class="sp-empty">學生專區內容尚未建立</p>`}</div>
    ${feedbackHtml()}
    </div></main>${modalHtml()}`;
}

function modalHtml() {
  if (!state.modal) return "";
  if (state.modal.kind === "preview") {
    return `<div class="xlsx-preview" data-action="close-modal"><div class="xlsx-preview__card"><div class="xlsx-preview__header"><div class="xlsx-preview__title">${esc(state.modal.title)}</div><button type="button" class="xlsx-preview__close" data-action="close-modal" aria-label="關閉預覽">×</button></div><div class="xlsx-preview__body"><pre class="xlsx-preview__text">${esc(state.modal.content)}</pre></div></div></div>`;
  }
  if (state.modal.kind === "pdf") {
    return `<div class="xlsx-preview" data-action="close-modal"><div class="xlsx-preview__card"><div class="xlsx-preview__header"><div class="xlsx-preview__title">${esc(state.modal.title)} 預覽</div><button type="button" class="xlsx-preview__close" data-action="close-modal" aria-label="關閉預覽">×</button></div><div class="xlsx-preview__body"><iframe class="xlsx-preview__pdf" src="${esc(state.modal.url)}" title="${esc(state.modal.title)}"></iframe></div></div></div>`;
  }
  return `<div class="ch-modal-overlay" data-action="close-modal"><div class="ch-modal" role="dialog" aria-modal="true"><h2 class="ch-modal__title">${esc(state.modal.title)}</h2><p class="ch-modal__body">${esc(state.modal.body)}</p><div class="ch-modal__actions"><button type="button" class="ch-modal__btn" data-action="close-modal">取消</button><button type="button" class="ch-modal__btn ch-modal__btn--danger" data-action="confirm-modal">刪除</button></div></div></div>`;
}

async function refreshSession() {
  state.session = await api("/api/access/session");
}

async function enterAfterLogin() {
  state.loginBusy = false;
  state.localBusy = false;
  await refreshSession();
  if (state.session?.role === "admin") {
    state.view = "list";
    paint();
    return;
  }
  const only = state.session?.catalog?.[0];
  if (only) await openCourse(only.courseId);
  else {
    state.view = "list";
    paint();
  }
}

async function openCourse(courseId) {
  stopPolls();
  state.courseId = courseId;
  state.view = "loading";
  state.loadMessage = "正在載入課程...";
  paint();
  let content;
  let channel;
  try {
    [content, channel] = await Promise.all([
      api(`/api/courses/${encodeURIComponent(courseId)}/content`),
      api(`/api/courses/${encodeURIComponent(courseId)}/channel`),
    ]);
  } catch {
    state.view = state.session?.role === "admin" ? "list" : "login";
    state.loginBusy = false;
    state.loginError = "課程內容載入失敗，請再試一次";
    paint();
    return;
  }
  state.content = content;
  state.messages = channel.messages || [];
  state.feedbackDone = localStorage.getItem(`feedback:${courseId}`) === "1";
  if (state.session?.role === "admin") {
    try {
      const feedback = await api(`/api/courses/${encodeURIComponent(courseId)}/feedback`);
      state.feedbackItems = feedback.items || [];
    } catch {
      state.feedbackItems = [];
    }
  }
  state.view = "course";
  const next = new URL(location.href);
  next.searchParams.set("group", courseOf(courseId)?.accessCode || "");
  history.replaceState(null, "", `${next.pathname}${next.search}`);
  paint();
  channelTimer = setInterval(refreshChannel, 5000);
  if (state.session?.role === "admin") feedbackTimer = setInterval(refreshFeedback, 10000);
}

async function refreshChannel() {
  if (state.view !== "course") return;
  try {
    const channel = await api(`/api/courses/${encodeURIComponent(state.courseId)}/channel`);
    state.messages = channel.messages || [];
    const feed = document.querySelector("#feed");
    const signature = state.messages.map((message) => `${message.id}:${message.pinned}:${message.available}:${message.content || ""}`).join("|");
    if (feed && !state.modal && feed.dataset.sig !== signature) {
      feed.dataset.sig = signature;
      feed.innerHTML = feedInner();
    }
  } catch {
    /* 下一次輪詢再試 */
  }
}

async function refreshFeedback() {
  if (state.view !== "course" || state.session?.role !== "admin") return;
  try {
    const feedback = await api(`/api/courses/${encodeURIComponent(state.courseId)}/feedback`);
    state.feedbackItems = feedback.items || [];
    const list = document.querySelector("#fb-admin-list");
    const count = document.querySelector("#fb-count");
    const signature = state.feedbackItems.map((item) => item.id).join("|");
    if (count) count.textContent = String(state.feedbackItems.length);
    if (list && !state.modal && list.dataset.sig !== signature) {
      list.dataset.sig = signature;
      list.innerHTML = state.feedbackItems.length
        ? `<div class="fb-admin-list">${state.feedbackItems.map((item) => `<article class="fb-admin-item"><div class="fb-admin-item__head"><time class="fb-admin-item__time">${esc(formatStamp(item.createdAt))}</time></div><p class="fb-admin-item__comment">${esc(item.comment)}</p><div class="fb-admin-item__actions"><button type="button" class="fb-admin-item__delete" data-action="ask-delete-feedback" data-id="${esc(item.id)}">刪除</button></div></article>`).join("")}</div>`
        : `<div class="fb-admin-empty">尚無學生回饋</div>`;
    }
  } catch {
    /* 下一次輪詢再試 */
  }
}

async function copyText(id, button) {
  const text = texts.get(id);
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  if (!button) return;
  const old = button.textContent;
  button.textContent = "已複製";
  button.classList.add("copied", "is-copied");
  setTimeout(() => {
    button.textContent = old === "已複製" ? "複製" : old;
    button.classList.remove("copied", "is-copied");
  }, 2000);
}

function setComposer(kind, text, ms = 0) {
  state.composer = { kind, text };
  paint();
  const box = document.querySelector("#composer");
  if (box) box.value = state.draft;
  if (ms) setTimeout(() => {
    state.composer = { kind: "idle", text: "" };
    const status = document.querySelector(".composer__status");
    if (status) status.remove();
  }, ms);
}

async function sendDraft() {
  const content = state.draft.trim();
  if (!content || state.composer.kind === "loading") return;
  setComposer("loading", "發送中...");
  try {
    await api(`/api/courses/${encodeURIComponent(state.courseId)}/channel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    state.draft = "";
    await refreshChannel();
    setComposer("success", "✓ 已送出", 1500);
  } catch (error) {
    setComposer("error", `發送失敗：${error.message}`);
  }
}

async function uploadFile(file) {
  if (!file || state.composer.kind === "loading") return;
  setComposer("loading", `上傳中：${file.name}`);
  try {
    const form = new FormData();
    form.append("file", file);
    const uploaded = await api(`/api/courses/${encodeURIComponent(state.courseId)}/channel/upload`, {
      method: "POST",
      body: form,
    });
    await api(`/api/courses/${encodeURIComponent(state.courseId)}/channel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "file",
        file_id: uploaded.id,
        file_name: uploaded.name,
        file_mime: uploaded.mime,
      }),
    });
    await refreshChannel();
    setComposer("success", `✓ 已上傳：${file.name}`, 2000);
  } catch (error) {
    setComposer("error", `上傳失敗：${error.message}`);
  }
}

async function downloadLocalFile(anchor) {
  const response = await fetch(anchor.getAttribute("href"));
  if (!response.ok) {
    window.alert("這個檔案還沒有在本機。請用老師代碼登入後，在上課素材重新上傳。");
    return;
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = anchor.dataset.name || "download";
  link.click();
  URL.revokeObjectURL(url);
}

document.addEventListener("input", (event) => {
  if (event.target.id === "code") {
    state.code = event.target.value;
    const button = document.querySelector("[data-action='login']");
    if (button) button.disabled = state.loginBusy || !state.code.trim();
  }
  if (event.target.id === "composer") state.draft = event.target.value;
  if (event.target.id === "fb-comment") state.comment = event.target.value;
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.modal) {
    state.modal = null;
    paint();
  }
  if (event.target.id === "code" && event.key === "Enter") {
    event.preventDefault();
    document.querySelector("[data-action='login']")?.click();
  }
  if (event.target.id === "composer" && event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendDraft();
  }
});

document.addEventListener("dragover", (event) => {
  const box = document.querySelector("#composer-box");
  if (!box || !event.target.closest("#composer-box")) return;
  event.preventDefault();
  state.dragging = true;
  document.querySelector("#composer")?.classList.add("is-dragging");
});

document.addEventListener("dragleave", (event) => {
  if (event.target.id !== "composer") return;
  state.dragging = false;
  event.target.classList.remove("is-dragging");
});

document.addEventListener("drop", (event) => {
  const box = event.target.closest?.("#composer-box");
  if (!box) return;
  event.preventDefault();
  state.dragging = false;
  document.querySelector("#composer")?.classList.remove("is-dragging");
  const file = event.dataTransfer?.files?.[0];
  if (file) uploadFile(file);
});

document.addEventListener("click", async (event) => {
  const node = event.target.closest("[data-action]");
  if (!node || !app.contains(node)) return;
  const action = node.dataset.action;
  if (action === "close-modal" && event.target !== node && !node.classList.contains("xlsx-preview__close") && !node.classList.contains("ch-modal__btn")) return;
  if (action === "toggle-code") {
    state.showCode = !state.showCode;
    paint();
    document.querySelector("#code")?.focus();
    return;
  }
  if (action === "login") {
    state.loginBusy = true;
    state.loginError = "";
    paint();
    try {
      await api("/api/access/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: state.code.trim() }),
      });
      state.loadMessage = "登入完成，正在載入課程...";
      state.view = "loading";
      paint();
      await enterAfterLogin();
    } catch (error) {
      state.view = "login";
      state.loginBusy = false;
      state.loginError = error.status === 429 ? "嘗試次數過多，請稍後再試" : error.status === 401 ? "代碼錯誤" : "連線失敗";
      paint();
    }
    return;
  }
  if (action === "local-admin") {
    state.localBusy = true;
    state.localError = "";
    paint();
    try {
      await api("/api/access/local-admin", { method: "POST" });
      state.view = "loading";
      state.loadMessage = "登入完成，正在載入課程...";
      paint();
      await enterAfterLogin();
    } catch {
      state.view = "login";
      state.localBusy = false;
      state.localError = "無法啟用本機後臺，請確認目前使用開發模式。";
      paint();
    }
    return;
  }
  if (action === "logout") {
    stopPolls();
    await api("/api/access/logout", { method: "POST" }).catch(() => {});
    state.session = { hasAccess: false, role: "visitor", catalog: [] };
    state.view = "login";
    state.code = "";
    state.loginBusy = false;
    state.localBusy = false;
    showHome();
    paint();
    return;
  }
  if (action === "open-course") {
    await openCourse(node.dataset.course);
    return;
  }
  if (action === "back-list") {
    stopPolls();
    state.view = "list";
    showHome();
    paint();
    return;
  }
  if (action === "copy") {
    event.preventDefault();
    const button = node.classList.contains("prompt-box__copy") || node.classList.contains("download-card__btn") || node.classList.contains("msg__action-btn") || node.classList.contains("course-row__copy")
      ? node
      : node.querySelector("[data-action='copy'].download-card__btn");
    await copyText(node.dataset.textId, button);
    return;
  }
  if (action === "preview") {
    event.stopPropagation();
    state.modal = { kind: "preview", title: `${node.dataset.title} 預覽`, content: texts.get(node.dataset.textId) || "" };
    paint();
    return;
  }
  if (action === "preview-url") {
    state.modal = { kind: "pdf", title: node.dataset.title, url: node.dataset.url };
    paint();
    return;
  }
  if (action === "download-file") {
    event.preventDefault();
    await downloadLocalFile(node);
    return;
  }
  if (action === "pin") {
    await api(`/api/courses/${encodeURIComponent(state.courseId)}/channel?id=${encodeURIComponent(node.dataset.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: node.dataset.pinned !== "1" }),
    });
    await refreshChannel();
    return;
  }
  if (action === "ask-delete-message") {
    state.modal = { kind: "confirm", title: "刪除訊息", body: "確定要刪除這則訊息嗎？此操作無法復原。", target: "message", id: node.dataset.id };
    paint();
    return;
  }
  if (action === "ask-delete-feedback") {
    state.modal = { kind: "confirm", title: "刪除回饋", body: "確定要刪除這筆回饋嗎？此操作無法復原。", target: "feedback", id: node.dataset.id };
    paint();
    return;
  }
  if (action === "confirm-modal" && state.modal?.kind === "confirm") {
    const modal = state.modal;
    state.modal = null;
    const base = `/api/courses/${encodeURIComponent(state.courseId)}/${modal.target === "message" ? "channel" : "feedback"}?id=${encodeURIComponent(modal.id)}`;
    await api(base, { method: "DELETE" });
    if (modal.target === "message") await refreshChannel();
    else await refreshFeedback();
    paint();
    return;
  }
  if (action === "close-modal") {
    state.modal = null;
    paint();
    return;
  }
  if (action === "send-feedback") {
    const comment = state.comment.trim();
    if (!comment) {
      state.feedbackError = "請寫一些內容再送出";
      paint();
      return;
    }
    state.feedbackBusy = true;
    state.feedbackError = "";
    paint();
    try {
      await api(`/api/courses/${encodeURIComponent(state.courseId)}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ comment }),
      });
      localStorage.setItem(`feedback:${state.courseId}`, "1");
      state.comment = "";
      state.feedbackDone = true;
    } catch (error) {
      state.feedbackError = error.status === 429 ? "提交太頻繁，請稍後再試" : "送出失敗，請稍後再試";
    } finally {
      state.feedbackBusy = false;
      paint();
    }
    return;
  }
  if (action === "feedback-again") {
    localStorage.removeItem(`feedback:${state.courseId}`);
    state.feedbackDone = false;
    state.comment = "";
    state.feedbackError = "";
    paint();
  }
});

async function boot() {
  paint();
  try {
    if (PAGES) {
      const response = await fetch(new URL("data.json", siteBase), { cache: "no-store" });
      if (!response.ok) throw new Error("data");
      pageData = await response.json();
    }
    if (state.isLocal) {
      api("/api/access/local-admin").then((row) => {
        if (row?.code) console.log("[本機開發] 管理員登入代碼：", row.code);
      }).catch(() => {});
    }
    await refreshSession();
    if (!state.session?.hasAccess) {
      state.view = "login";
      paint();
      return;
    }
    const group = new URLSearchParams(location.search).get("group");
    const matched = (state.session.catalog || []).find((course) => course.accessCode === group);
    if (state.session.role === "student" && state.session.catalog?.length === 1) {
      await openCourse(state.session.catalog[0].courseId);
      return;
    }
    if (matched) {
      await openCourse(matched.courseId);
      return;
    }
    state.view = state.session.role === "admin" ? "list" : "login";
    if (state.view === "login") state.session = { hasAccess: false, role: "visitor", catalog: [] };
    paint();
  } catch {
    state.view = "loading";
    state.loadMessage = "連線暫時不穩，正在重新確認登入狀態...";
    paint();
    setTimeout(boot, 3000);
  }
}

boot();
