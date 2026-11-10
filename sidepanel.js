let lastAnswers = null;
let stopAutopilot = false;
const LAST_ANSWERS_KEY = "lastQuizAnswers";
const LAST_ANSWER_TEXTS_KEY = "lastQuizAnswerTexts";
const LAST_QUESTIONS_KEY = "lastQuizQuestions";
const QUIZ_HISTORY_PREFIX = "qh:";
const STOP_REQUEST_KEY = "autopilotStopRequested";
const CONTROL_ACTION = new URLSearchParams(location.search).get("control");

const elements = {
  brandSub: document.querySelector(".brand-sub"),
  sendButton: document.querySelector("#sendButton"),
  autoFillButton: document.querySelector("#autoFillButton"),
  retryButton: document.querySelector("#retryButton"),
  assignmentButton: document.querySelector("#assignmentButton"),
  autopilotButton: document.querySelector("#autopilotButton"),
  autopilotSingleButton: document.querySelector("#autopilotSingleButton"),
  stopButton: document.querySelector("#stopButton"),
  reviewButton: document.querySelector("#reviewButton"),
  previewButton: document.querySelector("#previewButton"),
  copyCleanButton: document.querySelector("#copyCleanButton"),
  downloadLogButton: document.querySelector("#downloadLogButton"),
  clearLogButton: document.querySelector("#clearLogButton"),
  settingsPanel: document.querySelector("#settingsPanel"),
  settingsButton: document.querySelector("#settingsButton"),
  backButton: document.querySelector("#backButton"),
  saveButton: document.querySelector("#saveButton"),
  apiKey: document.querySelector("#apiKey"),
  model: document.querySelector("#model"),
  instruction: document.querySelector("#instruction"),
  exclusionPhrase: document.querySelector("#exclusionPhrase"),
  retryMode: document.querySelector("#retryMode"),
  saveStatus: document.querySelector("#saveStatus"),
  status: document.querySelector("#status"),
  conversation: document.querySelector("#conversation"),
  preview: document.querySelector("#preview")
};

function showSettings(isVisible) {
  document.querySelector("#readerPanel").hidden = isVisible;
  elements.settingsPanel.hidden = !isVisible;
  elements.settingsButton.hidden = isVisible;
}

async function logEvent(entry) {
  try {
    const stored = await chrome.storage.local.get("logs");
    const logs = stored.logs || [];
    logs.push({ time: new Date().toISOString(), ...entry });
    await chrome.storage.local.set({ logs: logs.slice(-1000) });
  } catch {
    // Логирование не должно ломать основной поток.
  }
}

async function getSettings() {
  const stored = await chrome.storage.local.get(["apiKey", "model", "instruction", "exclusionPhrase", "retryMode"]);

  return {
    apiKey: stored.apiKey || "",
    proApiKey: stored.proApiKey || "",
    model: stored.model || "deepseek-flash",
    proModel: stored.proModel || "deepseek-v4-pro-0813",
    instruction: stored.instruction || "",
    exclusionPhrase: stored.exclusionPhrase || "",
    retryMode: stored.retryMode === "text" ? "text" : "index"
  };
}

async function saveSettings() {
  await chrome.storage.local.set({
    apiKey: elements.apiKey.value.trim(),
    model: elements.model.value.trim() || "deepseek-flash",
    instruction: elements.instruction.value.trim(),
    exclusionPhrase: elements.exclusionPhrase.value.trim(),
    retryMode: elements.retryMode.value === "text" ? "text" : "index"
  });
  setStatus(elements.saveStatus, "Сохранено локально.");
}

async function initialize() {
  // Свежая загрузка панели = в этом контексте автопилот точно не крутится.
  // Сбрасываем флаг, чтобы закрытие/переоткрытие панели не блокировало запуск.
  await resetAutopilotFlag();
  const settings = await getSettings();

  const config = await chrome.runtime.sendMessage({ type: "get-config" }).catch(() => null);

  if (config?.ok) {
    elements.brandSub.textContent = `${config.provider} · v${config.version}`;
  } else {
    elements.brandSub.textContent = "фон не обновлён";
    setStatus(elements.status, "Перезагрузи расширение в chrome://extensions: фон ещё старый.", true);
  }

  elements.apiKey.value = settings.apiKey;
  elements.model.value = settings.model;
  elements.instruction.value = settings.instruction;
  elements.exclusionPhrase.value = settings.exclusionPhrase;
  elements.retryMode.value = settings.retryMode;
}

function setStatus(target, message, isError = false) {
  target.textContent = message;
  target.classList.toggle("error", isError);
  target.classList.toggle("done", !isError && /^(Готово|Скачан|Извлечено|Сохранено)/.test(String(message)));
}

function renderAnswer(answer) {
  const message = document.createElement("article");
  message.className = "message";

  const label = document.createElement("span");
  label.className = "message-label";
  label.textContent = "DEEPSEEK";

  const content = document.createElement("div");
  content.textContent = answer;
  message.append(label, content);
  elements.conversation.replaceChildren(message);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    throw new Error("Не удалось определить текущую вкладку.");
  }

  return tab;
}

async function extractPage(tabId, exclusionPhrase) {
  const extractionRequest = {
    type: "extract-clean-page",
    exclusionPhrase,
    characterLimit: 60000
  };
  let response;

  try {
    response = await sendToTab(tabId, extractionRequest);
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["page-cleaner.js", "content.js"]
    });
    response = await sendToTab(tabId, extractionRequest);
  }

  if (!response?.ok) {
    throw new Error(response?.error || "Не удалось прочитать страницу.");
  }

  return response.page;
}

async function previewCurrentPage() {
  elements.previewButton.disabled = true;
  setStatus(elements.status, "Читаю и очищаю body…");

  try {
    const [settings, tab] = await Promise.all([
      getSettings(),
      getActiveTab()
    ]);
    const page = await extractPage(tab.id, settings.exclusionPhrase);

    elements.preview.textContent = page.html;
    elements.preview.hidden = false;
    setStatus(elements.status, `Извлечено ${page.html.length} символов.`);
  } catch (error) {
    setStatus(elements.status, error.message, true);
  } finally {
    elements.previewButton.disabled = false;
  }
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[character]));
}

async function toDataUrl(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const blob = await response.blob();

  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Не удалось прочитать изображение."));
    reader.readAsDataURL(blob);
  });
}

function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

async function downloadCleanPage() {
  elements.copyCleanButton.disabled = true;
  setStatus(elements.status, "Собираю страницу…");

  try {
    const [settings, tab] = await Promise.all([
      getSettings(),
      getActiveTab()
    ]);

    const page = await extractPage(tab.id, settings.exclusionPhrase);
    let text = page.html || "";
    let images = Array.isArray(page.images) ? page.images.slice() : [];

    if (!page.quizItemCount) {
      const response = await sendToTab(tab.id, { type: "extract-assignment" });

      if (response?.ok && response.page) {
        text = response.page.text || text;

        if (Array.isArray(response.page.images) && response.page.images.length) {
          images = response.page.images;
        }
      }
    }

    if (!text.trim() && !images.length) {
      throw new Error("Нечего сохранять — страница пустая.");
    }

    setStatus(elements.status, `Качаю картинок: ${images.length}…`);

    const fetched = [];

    for (let i = 0; i < images.length; i++) {
      const dataUrl = await toDataUrl(images[i]).catch(() => null);

      if (dataUrl) {
        fetched.push({ index: i + 1, dataUrl });
      }
    }

    const textFile = text.trim() || "(нет текста)";

    const imagesHtml = fetched
      .map((image) => `<figure><img src="${image.dataUrl}" alt="image ${image.index}"><figcaption>Изображение ${image.index}</figcaption></figure>`)
      .join("\n");

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(page.title || "task")}</title>` +
      `<style>body{font-family:system-ui,"Segoe UI",sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#111}` +
      `pre{white-space:pre-wrap;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:1.5;background:#f6f6f6;padding:12px;border-radius:8px}` +
      `figure{margin:16px 0}img{max-width:100%;border:1px solid #ccc;border-radius:6px}figcaption{color:#666;font-size:12px}</style>` +
      `</head><body><h1>${escapeHtml(page.title || "Task")}</h1>` +
      `<p><a href="${escapeHtml(page.url || "")}">${escapeHtml(page.url || "")}</a></p>` +
      `<pre>${escapeHtml(textFile)}</pre>${imagesHtml}</body></html>`;

    const fileName = `${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}.html`;
    downloadBlob(fileName, new Blob([html], { type: "text/html;charset=utf-8" }));

    elements.preview.textContent = textFile;
    elements.preview.hidden = false;
    setStatus(elements.status, `Скачан HTML (текст + ${fetched.length} картинок).`);
  } catch (error) {
    setStatus(elements.status, error.message, true);
  } finally {
    elements.copyCleanButton.disabled = false;
  }
}

function parseJsonArray(answer) {
  const start = answer.indexOf("[");

  if (start === -1) {
    throw new Error("DeepSeek не вернул JSON-массив.");
  }

  let depth = 0;
  let end = -1;

  for (let i = start; i < answer.length; i++) {
    if (answer[i] === "[") {
      depth++;
    } else if (answer[i] === "]") {
      depth--;

      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end === -1) {
    throw new Error("Не удалось разобрать JSON-массив.");
  }

  let parsed;

  try {
    parsed = JSON.parse(answer.slice(start, end + 1));
  } catch {
    throw new Error("DeepSeek вернул невалидный JSON.");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("DeepSeek вернул не массив.");
  }

  return parsed;
}

function normalizeAnswers(parsed, types, count) {
  if (parsed.length === count) {
    return parsed;
  }

  if (count === 1) {
    const type = types[0];

    if (type === "checkbox" && parsed.every((value) => Number.isInteger(Number(value)))) {
      return [parsed.map((value) => Number(value))];
    }

    if (type === "radio" && parsed.length === 1 && Array.isArray(parsed[0])) {
      return [parsed[0][0] ?? 0];
    }
  }

  throw new Error(`Ожидалось ${count} ответов, получено ${parsed.length}.`);
}

function isBlankAnswer(answer) {
  if (answer == null) {
    return true;
  }

  if (Array.isArray(answer)) {
    return answer.length === 0 || answer.every((entry) => isBlankAnswer(entry));
  }

  if (typeof answer === "number") {
    return !Number.isInteger(answer) || answer <= 0;
  }

  const text = String(answer).trim();

  if (!text) {
    return true;
  }

  const number = Number(text);

  return Number.isInteger(number) && number <= 0;
}

function mergeAnswers(base, extra) {
  return base.map((answer, index) =>
    isBlankAnswer(answer) && !isBlankAnswer(extra[index]) ? extra[index] : answer
  );
}

async function askDeepSeekForAnswers(settings, page, instruction, request, count, provider = "flash") {
  const types = page.quizTypes || [];
  let currentRequest = request;
  let best = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await chrome.runtime.sendMessage({
      type: "ask-deepseek",
      payload: {
        apiKey: settings.apiKey,
        proApiKey: settings.proApiKey || "",
        provider,
        model: provider === "pro" ? settings.proModel || "deepseek-v4-pro-0813" : settings.model,
        instruction,
        page,
        request: currentRequest,
        bypassCache: true,
        maxTokens: provider === "pro" ? 6000 : undefined
      }
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Не удалось получить ответ DeepSeek.");
    }

    let parsed = null;

    try {
      parsed = normalizeAnswers(parseJsonArray(response.answer), types, count);
    } catch (error) {
      if (attempt === 2 && !best) {
        throw error;
      }
    }

    if (parsed) {
      best = best ? mergeAnswers(best, parsed) : parsed;

      if (best.every((answer) => !isBlankAnswer(answer))) {
        return best;
      }
    }

    const missing = best
      ? best.map((answer, index) => (isBlankAnswer(answer) ? index + 1 : 0)).filter(Boolean)
      : [];

    currentRequest = missing.length
      ? `${request}\n\nВАЖНО: для вопросов ${missing.join(", ")} ответа нет. Верни РОВНО ${count} элементов, по одному на каждый вопрос, и обязательно заполни эти номера.`
      : `${request}\n\nВАЖНО: ты вернул неполный или невалидный массив. Верни РОВНО ${count} элементов, по одному на каждый вопрос.`;
  }

  if (best) {
    return best;
  }

  throw new Error("DeepSeek не вернул полный массив ответов.");
}

function pageHasImages(page) {
  return !!(page && page.images && page.images.length);
}

async function askProForAnswers(settings, page, instruction, request, count) {
  try {
    return await askDeepSeekForAnswers(settings, page, instruction, request, count, "pro");
  } catch (error) {
    // Pro недоступен (нет ключа, сеть, лимит): ретрай всё равно должен работать.
    await logEvent({ type: "pro-fallback", error: String(error?.message || error).slice(0, 200) });
    return await askDeepSeekForAnswers(settings, page, instruction, request, count, "flash");
  }
}

async function sendApplyAnswers(tabId, answers, page) {
  return chrome.tabs.sendMessage(tabId, {
    type: "apply-quiz-answers",
    answers,
    questions: page?.quizQuestions || [],
    types: page?.quizTypes || []
  });
}

async function askForSkippedQuestions(settings, page, skippedIndexes) {
  const types = page.quizTypes || [];
  const numbers = skippedIndexes.map((index) => index + 1);
  const request = [
    `Ниже тест. Для вопросов ${numbers.join(", ")} прошлый ответ не подошёл к разметке страницы.`,
    `Верни ТОЛЬКО JSON-массив из ${numbers.length} элементов: ответы именно для вопросов ${numbers.join(", ")}, по порядку.`,
    `Типы: ${skippedIndexes.map((index) => `вопрос ${index + 1} — ${types[index] || "неизвестен"}`).join(", ")}.`,
    "Формат: [ОДИН ВАРИАНТ] → номер в скобках (отсчёт с 1), [ОДИН ВАРИАНТ (выпадающий)] → номер пункта в скобках, [ВЫБЕРИ ВСЕ ВЕРНЫЕ] → массив номеров в скобках, [ВПИШИ ОТВЕТ] → строка, [ЧИСЛО] → только число без единиц.",
    "Не отвечай на остальные вопросы."
  ].join("\n");

  const trimmed = { ...page, quizTypes: skippedIndexes.map((index) => types[index] || "text") };

  const ask = pageHasImages(page) ? askDeepSeekForAnswers : askProForAnswers;

  return await ask(
    settings,
    trimmed,
    "Решай тест. Отвечай только за указанные вопросы.",
    request,
    skippedIndexes.length
  );
}

async function applyWithRepair(tabId, settings, page, answers) {
  let current = answers;
  let response = await sendApplyAnswers(tabId, current, page);

  if (!response?.ok) {
    throw new Error(response?.error || "Не удалось отметить ответы.");
  }

  for (let attempt = 0; attempt < 2 && response.result.skipped.length; attempt++) {
    const skippedIndexes = response.result.skipped.map((number) => number - 1);
    let patch = null;

    try {
      patch = await askForSkippedQuestions(settings, page, skippedIndexes);
    } catch {
      patch = null;
    }

    if (!Array.isArray(patch) || patch.length !== skippedIndexes.length) {
      break;
    }

    current = current.slice();
    skippedIndexes.forEach((questionIndex, offset) => {
      current[questionIndex] = patch[offset];
    });

    response = await sendApplyAnswers(tabId, current, page);

    if (!response?.ok) {
      throw new Error(response?.error || "Не удалось отметить ответы.");
    }
  }

  return { answers: current, result: response.result };
}

async function autoFillPage() {
  elements.autoFillButton.disabled = true;
  setStatus(elements.status, "Читаю тест…");

  try {
    const [settings, tab] = await Promise.all([
      getSettings(),
      getActiveTab()
    ]);
    let page = await extractPage(tab.id, settings.exclusionPhrase || "");
    const start = await sendToTab(tab.id, { type: "click-start" }).catch(() => null);

    if (start?.clicked) {
      // Обложка задания: нажали Resume/Start, ждём, пока форму покажут.
      await sleep(1500);
      page = await extractPage(tab.id, settings.exclusionPhrase || "");
    }

    if (!page.quizItemCount) {
      throw new Error("На странице не найден тест.");
    }

    setStatus(elements.status, "Прошу DeepSeek выбрать ответы…");

    let answers = await askDeepSeekForAnswers(
      settings,
      page,
      "Решай тест. Для каждого вопроса дай ответ строго по его типу.",
      `Ниже тест из ${page.quizItemCount} вопросов. Ответь по типу каждого вопроса:\n- [ОДИН ВАРИАНТ] → номер правильного варианта в скобках (целое число, отсчёт с 1).\n- [ОДИН ВАРИАНТ (выпадающий)] → тоже номер пункта в скобках.\n- [ВЫБЕРИ ВСЕ ВЕРНЫЕ] → массив номеров в скобках, напр. [1,3].\n- [ВПИШИ ОТВЕТ] → строка с ответом.\n- [ЧИСЛО] → только число, без единиц и текста (десятичная точка).\nВерни ТОЛЬКО JSON-массив из ${page.quizItemCount} элементов в порядке вопросов, без пояснений. Пример: [1, [1,3], "AB", 2]`,
      page.quizItemCount
    );

    setStatus(elements.status, "Отмечаю ответы на странице…");

    const repaired = await applyWithRepair(tab.id, settings, page, answers);
    answers = repaired.answers;

    const { applied, skipped, honorChecked } = repaired.result;

    if (skipped.length) {
      throw new Error(`Не удалось отметить вопросы: ${skipped.join(", ")}. Тест не отправлен.`);
    }

    lastAnswers = answers;

    const optionTexts = page.quizOptions || [];
    const answerTexts = answers.map((answer, index) => {
      const options = optionTexts[index] || [];
      const items = Array.isArray(answer) ? answer : [answer];
      return items
        .map((value) => (typeof value === "number" && options[value - 1] ? options[value - 1] : typeof value === "string" ? value : ""))
        .filter(Boolean);
    });

    await chrome.storage.local.set({
      [LAST_ANSWERS_KEY]: answers,
      [LAST_ANSWER_TEXTS_KEY]: answerTexts,
      [LAST_QUESTIONS_KEY]: page.quizQuestions || []
    });

    setStatus(elements.status, "Нажимаю Submit…");

    let submitNote = " Submit: не найден.";

    try {
      const submitResponse = await chrome.tabs.sendMessage(tab.id, { type: "submit-quiz" });

      if (submitResponse?.ok && submitResponse.result?.submitted) {
        submitNote = " Submit: нажат.";
      }
    } catch {
      // Submit не критичен — ответы уже заполнены.
    }

    renderAnswer(
      `Отмечено ${applied.length} из ${page.quizItemCount}.` +
        (skipped.length ? ` Пропущено: ${skipped.join(", ")}.` : "") +
        (honorChecked ? " Чекбокс honor code: отмечен." : " Чекбокс honor code: не найден.") +
        submitNote
    );
    setStatus(elements.status, "Готово.");
  } catch (error) {
    setStatus(elements.status, error.message, true);
  } finally {
    elements.autoFillButton.disabled = false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

async function isStopRequested() {
  if (stopAutopilot) {
    return true;
  }

  try {
    const stored = await chrome.storage.local.get(STOP_REQUEST_KEY);
    return !!stored[STOP_REQUEST_KEY];
  } catch {
    return false;
  }
}

const AUTOPILOT_BEAT_KEY = "autopilotLastBeat";
const BEAT_INTERVAL_MS = 20 * 1000;
const BEAT_STALE_MS = 45 * 1000;
let heartbeatTimer = null;

function startHeartbeat() {
  stopHeartbeat();
  const beat = () => chrome.storage.local.set({ [AUTOPILOT_BEAT_KEY]: Date.now() }).catch(() => {});
  beat();
  heartbeatTimer = setInterval(beat, BEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

async function autopilotIsActive() {
  try {
    const state = await chrome.storage.local.get(["autopilotRunning", AUTOPILOT_BEAT_KEY, "autopilotStartedAt"]);
    if (!state.autopilotRunning) {
      return false;
    }
    const beat = state[AUTOPILOT_BEAT_KEY] || state.autopilotStartedAt || 0;
    return Date.now() - beat < BEAT_STALE_MS;
  } catch {
    return false;
  }
}

async function resetAutopilotFlag() {
  try {
    stopHeartbeat();
    await chrome.storage.local.set({ autopilotRunning: false });
    await chrome.storage.local.remove(AUTOPILOT_BEAT_KEY);
  } catch {
    // не критично
  }
}

let forceStartArmedAt = 0;

async function confirmAutopilotStart() {
  const active = await autopilotIsActive();

  if (!active) {
    forceStartArmedAt = 0;
    return true;
  }

  if (Date.now() - forceStartArmedAt < 5000) {
    forceStartArmedAt = 0;
    await resetAutopilotFlag();
    return true;
  }

  forceStartArmedAt = Date.now();
  setStatus(
    elements.status,
    "Автопилот помечен как запущенный. Нажми ещё раз в течение 5 сек, чтобы запустить принудительно.",
    true
  );
  return false;
}

function normalizeTabUrl(value) {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, "").replace(/\/(?:attempt|view-feedback)$/, "");
    return `${url.origin}${path}`;
  } catch {
    return String(value || "").replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

function sameTabUrl(left, right) {
  return normalizeTabUrl(left) === normalizeTabUrl(right);
}

function normalizeExactUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return String(value || "").replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

function sameExactUrl(left, right) {
  return normalizeExactUrl(left) === normalizeExactUrl(right);
}

async function getTabOrThrow(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    throw new Error(`Вкладка ${tabId} закрыта.`);
  }
}

async function waitForTabReady(tabId, expectedUrl, { timeoutMs = 30000, requireExact = true, exactPath = false, initialUrl = null } = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  while (Date.now() < deadline) {
    const tab = await getTabOrThrow(tabId);
    const sameUrl = exactPath ? sameExactUrl(tab.url, expectedUrl) : sameTabUrl(tab.url, expectedUrl);
    const redirected = !requireExact && initialUrl && tab.url !== initialUrl;
    const graceExpired = !requireExact && Date.now() - startedAt > 5000;

    if (tab.status === "complete" && (sameUrl || redirected || graceExpired)) {
      return tab;
    }

    if (await isStopRequested()) {
      return tab;
    }

    await sleep(250);
  }

  throw new Error("Страница не загрузилась вовремя.");
}

async function navigateTab(tabId, url, { force = false, requireExact = true, exactPath = false, timeoutMs = 30000 } = {}) {
  let tab = await getTabOrThrow(tabId);
  const initialUrl = tab.url;

  if (!force && sameTabUrl(tab.url, url)) {
    if (tab.status === "complete") {
      return tab;
    }

    if (tab.status !== "unloaded") {
      try {
        return await waitForTabReady(tabId, url, { requireExact, exactPath, timeoutMs: Math.min(8000, timeoutMs) });
      } catch {
        // Ниже принудительно перезагрузим зависшую вкладку.
      }
    }

    force = true;
  }

  try {
    await chrome.tabs.update(tabId, { url });
  } catch (error) {
    if (!/Navigation rejected/i.test(error.message)) {
      throw error;
    }

    await sleep(400);
    tab = await getTabOrThrow(tabId);

    if (!sameTabUrl(tab.url, url) && !sameTabUrl(tab.pendingUrl, url)) {
      await chrome.tabs.update(tabId, { url });
    }
  }

  return await waitForTabReady(tabId, url, { timeoutMs, requireExact, exactPath, initialUrl });
}

async function sendToTab(tabId, message, { retries = 3 } = {}) {
  let lastError;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await withTimeout(chrome.tabs.sendMessage(tabId, message), 8000, "Контент-скрипт не ответил.");
    } catch (error) {
      lastError = error;

      if (/No tab with id/i.test(error.message)) {
        throw error;
      }

      await sleep(250 * (attempt + 1));

      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["page-cleaner.js", "content.js"]
        });
      } catch (injectError) {
        lastError = injectError;
      }
    }
  }

  throw lastError;
}

function isReviewPage(html) {
  const lower = html.toLowerCase().replace(/[\u2018\u2019]/g, "'");
  return (
    lower.includes("nice work") ||
    lower.includes("try again") ||
    lower.includes("your grade") ||
    lower.includes("didn't pass") ||
    lower.includes("you didn")
  );
}

async function clickRetry(tabId) {
  try {
    const response = await sendToTab(tabId, { type: "click-retry" });
    return !!(response?.ok && response.clicked);
  } catch {
    return false;
  }
}

async function enterCourse(tabId) {
  try {
    const response = await sendToTab(tabId, { type: "enter-course" });
    return response?.ok ? response.result : null;
  } catch {
    return null;
  }
}

async function retryPage() {
  elements.retryButton.disabled = true;
  setStatus(elements.status, "Читаю страницу с результатами…");

  try {
    const [settings, tab] = await Promise.all([
      getSettings(),
      getActiveTab()
    ]);
    const exclusionPhrase = settings.exclusionPhrase || "";

    const reviewPage = await extractFullText(tab.id);
    const statuses = await getQuestionStatuses(tab.id);
    const reviewEntries = await getAnsweredQuiz(tab.id);
    const retryMode = settings.retryMode === "text" ? "text" : "index";
    let storedAnswerTexts = [];
    let storedQuestions = [];
    let pageAnswerEntries = null;

    if (!lastAnswers) {
      const stored = await chrome.storage.local.get([
        LAST_ANSWERS_KEY,
        LAST_ANSWER_TEXTS_KEY,
        LAST_QUESTIONS_KEY
      ]);
      lastAnswers = stored[LAST_ANSWERS_KEY] || null;
      storedAnswerTexts = stored[LAST_ANSWER_TEXTS_KEY] || [];
      storedQuestions = stored[LAST_QUESTIONS_KEY] || [];
    }

    if (!lastAnswers) {
      // Панель перезапускали, памяти нет — читаем прошлые ответы прямо со страницы.
      const hasAnswers = reviewEntries.some((entry) =>
        Array.isArray(entry.text) ? entry.text.length > 0 : String(entry.text || "").trim() !== ""
      );

      if (hasAnswers) {
        pageAnswerEntries = reviewEntries;
        lastAnswers = reviewEntries.map((entry) => (retryMode === "text" ? entry.text : entry.index));
        storedAnswerTexts = reviewEntries.map((entry) =>
          Array.isArray(entry.text) ? entry.text : [String(entry.text || "")]
        );
      }
    }

    if (!lastAnswers) {
      setStatus(elements.status, "Прошлых ответов не видно — решу заново по странице с результатами.");
    } else {
      setStatus(elements.status, "Жму «Ретрай»…");
    }

    const clicked = await clickRetry(tab.id);

    if (!clicked) {
      // Возможно, пользователь уже нажал Retake и тест перед нами.
      const current = await extractPage(tab.id, exclusionPhrase).catch(() => null);

      if (!(current && current.quizItemCount >= 1 && !isReviewPage(current.html))) {
        throw new Error("Кнопка «Ретрай»/«Resume assignment» не найдена на странице.");
      }
    }

    setStatus(elements.status, "Жду загрузки нового теста…");

    let freshPage = null;
    const deadline = Date.now() + 30000;

    while (Date.now() < deadline) {
      await sleep(2000);

      try {
        await chrome.tabs.sendMessage(tab.id, { type: "click-retry" });

        const page = await extractPage(tab.id, exclusionPhrase);

        if (page.quizItemCount >= 1 && !isReviewPage(page.html)) {
          freshPage = page;
          break;
        }
      } catch {
        // Страница ещё перезагружается, пробуем снова.
      }
    }

    if (!freshPage) {
      throw new Error("Новый тест не загрузился за 30 секунд. Нажми «Retake» вручную и повтори «Ретрай».");
    }

    // История попыток по этому тесту: что уже пробовали и что оказалось неверным.
    const history = await loadQuizHistory(freshPage);
    const reviewQuestions = reviewEntries.map((entry) => entry.question || "");
    const questionsForStatuses = reviewQuestions.some(Boolean)
      ? reviewQuestions
      : storedQuestions.length
        ? storedQuestions
        : freshPage.quizQuestions || [];
    const pageTexts = reviewEntries.map((entry) =>
      (Array.isArray(entry.text) ? entry.text : [String(entry.text || "")]).filter(Boolean)
    );
    const previousTexts = pageTexts.some((texts) => texts.length) ? pageTexts : storedAnswerTexts;

    statuses.forEach((status, index) => {
      const entry = historyEntry(history.data, questionsForStatuses[index]);

      if (!entry) {
        return;
      }

      entry.attempts = (entry.attempts || 0) + 1;

      if (status === "correct") {
        entry.correct = true;
      }

      if (status === "wrong") {
        const correct = new Set(
          (reviewEntries[index]?.correctTexts || []).map(normalizeHistoryText)
        );
        let texts = (previousTexts[index] || []).map((value) => String(value).trim()).filter(Boolean);

        if (!texts.length && lastAnswers) {
          texts = answerToHistoryTexts(lastAnswers[index], freshPage.quizOptions?.[index]);
        }

        // В checkbox страница может отметить часть выбранных как верные:
        // такие варианты запрещать нельзя.
        addBanned(entry, texts.filter((text) => !correct.has(normalizeHistoryText(text))));
        addBanned(entry, reviewEntries[index]?.wrongTexts || []);
      }
    });

    // Сопоставляем историю с новым порядком вопросов: по тексту, не по номеру.
    const triedList = (freshPage.quizQuestions || []).map((question) => {
      const entry = historyEntry(history.data, question);
      return new Set(entry ? entry.banned : []);
    });
    const remembered = Object.values(history.data.byQuestion).filter(
      (entry) => entry.banned && entry.banned.length
    ).length;

    // Сохраняем сразу: даже если запрос к модели упадёт, ошибки уже запомнены.
    await saveQuizHistory(freshPage, history.data);

    setStatus(
      elements.status,
      (pageHasImages(freshPage)
        ? "Прошу flash прочитать картинки и исправить…"
        : "Прошу Pro исправить ошибки…") + (remembered ? ` (помню ошибок: ${remembered})` : "")
    );

    let answers = await solveQuiz(settings, freshPage, lastAnswers, reviewPage, statuses, triedList, retryMode);

    // Если страница результатов сама показала верные варианты (checkbox), ставим их напрямую.
    const locked = new Set();

    reviewEntries.forEach((entry) => {
      if (!entry.correctTexts || !entry.correctTexts.length) {
        return;
      }

      const key = normalizeHistoryText(entry.question);
      const index = (freshPage.quizQuestions || []).findIndex(
        (question) => normalizeHistoryText(question) === key
      );

      if (index < 0) {
        return;
      }

      const options = freshPage.quizOptions?.[index] || [];
      const picked = entry.correctTexts
        .map((text) => {
          const optionIndex = options.findIndex(
            (option) => normalizeHistoryText(option) === normalizeHistoryText(text)
          );
          return optionIndex + 1;
        })
        .filter((number) => number > 0);

      if (!picked.length) {
        return;
      }

      answers[index] = freshPage.quizTypes?.[index] === "checkbox" ? picked : picked[0];
      locked.add(index);
    });

    // Жёсткая гарантия: вариант, который уже был неверным, не выбираем снова.
    enforceBans(freshPage, answers, triedList, locked);

    lastAnswers = answers;
    const freshAnswerTexts = (freshPage.quizQuestions || []).map((_, index) =>
      answerToHistoryTexts(answers[index], freshPage.quizOptions?.[index])
    );
    await chrome.storage.local.set({
      [LAST_ANSWERS_KEY]: answers,
      [LAST_ANSWER_TEXTS_KEY]: freshAnswerTexts,
      [LAST_QUESTIONS_KEY]: freshPage.quizQuestions || []
    });

    // Запоминаем, что пробовали в этот раз: на следующем ретрае это уже нельзя повторять.
    (freshPage.quizQuestions || []).forEach((question, index) => {
      const entry = historyEntry(history.data, question);

      if (!entry) {
        return;
      }

      entry.last = answerToHistoryTexts(answers[index], freshPage.quizOptions?.[index]);
    });
    await saveQuizHistory(freshPage, history.data);

    setStatus(elements.status, "Отмечаю исправленные ответы…");

    const repaired = await applyWithRepair(tab.id, settings, freshPage, answers);
    answers = repaired.answers;

    const { applied, skipped, honorChecked } = repaired.result;

    if (skipped.length) {
      throw new Error(`Не удалось отметить вопросы: ${skipped.join(", ")}. Тест не отправлен.`);
    }

    lastAnswers = answers;
    await chrome.storage.local.set({ [LAST_ANSWERS_KEY]: answers });

    setStatus(elements.status, "Нажимаю Submit…");

    let submitNote = " Submit: не найден.";

    try {
      const submitResponse = await chrome.tabs.sendMessage(tab.id, { type: "submit-quiz" });

      if (submitResponse?.ok && submitResponse.result?.submitted) {
        submitNote = " Submit: нажат.";
      }
    } catch {
      // Submit не критичен — ответы уже заполнены.
    }

    renderAnswer(
      `Исправлено и отмечено ${applied.length} из ${freshPage.quizItemCount}.` +
        (skipped.length ? ` Пропущено: ${skipped.join(", ")}.` : "") +
        (honorChecked ? " Чекбокс honor code: отмечен." : " Чекбокс honor code: не найден.") +
        submitNote
    );
    setStatus(elements.status, "Готово.");
  } catch (error) {
    setStatus(elements.status, error.message, true);
  } finally {
    elements.retryButton.disabled = false;
  }
}

async function fillAssignmentPage() {
  elements.assignmentButton.disabled = true;
  setStatus(elements.status, "Определяю тип задания…");

  try {
    const [settings, tab] = await Promise.all([
      getSettings(),
      getActiveTab()
    ]);

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["page-cleaner.js", "content.js"]
    });

    const typeResponse = await chrome.tabs.sendMessage(tab.id, { type: "detect-assignment-type" });
    let type = typeResponse?.ok ? typeResponse.type : "unknown";

    if (type === "quiz") {
      renderAnswer("Это квиз. Жми «Авто-заполнить ответы» — он сам решит и заполнит.");
      setStatus(elements.status, "Определён квиз.");
      return;
    }

    let extractResponse = await chrome.tabs.sendMessage(tab.id, { type: "extract-assignment" });

    if (!extractResponse?.ok) {
      throw new Error(extractResponse?.error || "Не удалось прочитать задание.");
    }

    let page = extractResponse.page;
    let editorCount = page.editorCount || 0;

    if (!editorCount) {
      setStatus(elements.status, "Открываю редактор (My submission)…");
      await chrome.tabs.sendMessage(tab.id, { type: "click-my-submission" });

      const deadline = Date.now() + 10000;

      while (Date.now() < deadline && !editorCount) {
        await sleep(1500);

        const again = await chrome.tabs.sendMessage(tab.id, { type: "extract-assignment" });

        if (again?.ok) {
          page = again.page;
          editorCount = page.editorCount || 0;
        }

        if (!editorCount) {
          await chrome.tabs.sendMessage(tab.id, { type: "click-my-submission" });
        }
      }

      const againType = await chrome.tabs.sendMessage(tab.id, { type: "detect-assignment-type" });

      if (againType?.ok && againType.type !== "unknown") {
        type = againType.type;
      }

      if (editorCount) {
        type = "richText";
      }
    }

    if (!editorCount && type !== "fileUpload") {
      throw new Error("Редактор не найден. Открой My submission вручную и повтори.");
    }

    setStatus(elements.status, "Прошу DeepSeek решить задание…");

    const multiPart = editorCount > 1;

    const response = await chrome.runtime.sendMessage({
      type: "ask-deepseek",
      payload: {
        apiKey: settings.apiKey,
        model: settings.model,
        instruction: "Ты решаешь домашнее задание по курсу. Дай подробные решения всех пунктов.",
        page: { title: page.title, url: page.url, html: page.text, images: [] },
        request:
          "Ниже текст домашнего задания. Реши все задачи и подпункты (a, b, c, d, ...). Пиши на английском, формулы текстом, полным развёрнутым решением, без JSON." +
          (multiPart
            ? ` Полей для ответа ${editorCount}. Реши каждую задачу отдельно и разделяй решения отдельной строкой =====PROBLEM===== .`
            : ""),
        maxTokens: 4000
      }
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Не удалось получить ответ DeepSeek.");
    }

    if (type === "fileUpload") {
      renderAnswer(
        "Это задание с загрузкой файла. Скопируй текст ниже в документ (Word/PDF) и загрузи вручную.\n\n" +
          response.answer
      );
      setStatus(elements.status, "Ответ готов — вставь в файл и загрузи.");
      return;
    }

    let texts;

    if (multiPart) {
      texts = response.answer
        .split(/=+\s*PROBLEM\s*=/)
        .map((part) => part.trim())
        .filter(Boolean);

      while (texts.length < editorCount) {
        texts.push("");
      }

      texts = texts.slice(0, editorCount);
    } else {
      texts = [response.answer];
    }

    setStatus(elements.status, "Заполняю редактор…");

    const fillResponse = await chrome.tabs.sendMessage(tab.id, { type: "fill-answer", texts });

    if (!fillResponse?.ok || fillResponse.result?.filled === 0) {
      throw new Error(fillResponse?.error || "Не удалось заполнить редактор.");
    }

    const display = multiPart
      ? texts.map((part, index) => `— ПОЛЕ ${index + 1} —\n${part}`).join("\n\n")
      : response.answer;

    renderAnswer(display);
    setStatus(
      elements.status,
      `Заполнено полей: ${fillResponse.result.filled} из ${fillResponse.result.total}. Проверь и жми Submit.`
    );
  } catch (error) {
    setStatus(elements.status, error.message, true);
  } finally {
    elements.assignmentButton.disabled = false;
  }
}

async function reviewPage() {
  elements.reviewButton.disabled = true;
  setStatus(elements.status, "Прохожу ревью…");

  try {
    const tab = await getActiveTab();
    const feedbackText = "goat";
    let done = 0;

    for (let i = 0; i < 30; i++) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["page-cleaner.js", "content.js"]
      });

      const countResponse = await chrome.tabs.sendMessage(tab.id, { type: "get-review-count" });
      const count = countResponse?.ok ? countResponse.count : -1;

      if (count === 0) {
        break;
      }

      if (count === -1) {
        if (i === 0) {
          throw new Error("Страница ревью не найдена (нет «Reviews left to complete»).");
        }
        break;
      }

      setStatus(elements.status, `Ревью ${i + 1}: осталось ${count}…`);

      const completeResponse = await chrome.tabs.sendMessage(tab.id, {
        type: "complete-peer-review",
        feedbackText
      });

      if (!completeResponse?.ok) {
        throw new Error(completeResponse?.error || "Не удалось заполнить ревью.");
      }

      const submitResponse = await chrome.tabs.sendMessage(tab.id, { type: "submit-review" });

      if (!submitResponse?.ok || !submitResponse.clicked) {
        throw new Error("Кнопка «Submit Review» не найдена.");
      }

      done++;
      await sleep(4000);
    }

    renderAnswer(`Ревью пройдено: ${done}.`);
    setStatus(elements.status, "Готово.");
  } catch (error) {
    setStatus(elements.status, error.message, true);
  } finally {
    elements.reviewButton.disabled = false;
  }
}

async function waitForQuiz(tabId, exclusionPhrase, expectedUrl, timeoutMs = 40000) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const attemptUrl = `${normalizeTabUrl(expectedUrl)}/attempt`;
  let directAttemptTried = false;
  let startTried = false;
  let reviewSince = 0;
  let lastRetryAt = 0;
  let lastPage = null;

  while (Date.now() < deadline) {
    if (await isStopRequested()) {
      await logEvent({ type: "wait-quiz-null", reason: "stop", url: expectedUrl, ms: Date.now() - startedAt });
      return null;
    }

    try {
      const tab = await getTabOrThrow(tabId);

      if (tab.status !== "complete" || !sameTabUrl(tab.url, expectedUrl)) {
        await sleep(500);
        continue;
      }

      const page = await extractPage(tabId, exclusionPhrase);
      lastPage = page;
      const onAttempt = /\/attempt\/?$/.test(new URL(tab.url).pathname);

      if (!startTried && !page.isReview && page.quizItemCount >= 1) {
        const start = await sendToTab(tabId, { type: "click-start" }).catch(() => null);

        if (start?.clicked) {
          startTried = true;
          await logEvent({ type: "start-click", url: expectedUrl, label: String(start.label || "").slice(0, 120) });
          await sleep(1500);
          continue;
        }

        startTried = true;
      }

      if (page.isReview || page.quizItemCount === 0) {
        if (!directAttemptTried && !onAttempt) {
          directAttemptTried = true;
          await navigateTab(tabId, attemptUrl, { force: true, exactPath: true, timeoutMs: 8000 }).catch(() => {});
          continue;
        }

        if (page.isReview) {
          if (!reviewSince) {
            reviewSince = Date.now();
          }

          if (Date.now() - reviewSince < 20000) {
            if (Date.now() - lastRetryAt > 2500) {
              lastRetryAt = Date.now();
              const clicked = await sendToTab(tabId, { type: "click-retry" }).catch(() => null);
              await logEvent({
                type: "retry-click",
                url: expectedUrl,
                clicked: !!clicked?.clicked,
                label: String(clicked?.label || "").slice(0, 120)
              });
            }

            await sleep(1000);
            continue;
          }

          await logEvent({ type: "wait-quiz-null", reason: "review", url: expectedUrl, ms: Date.now() - startedAt });
          return null;
        }
      }

      reviewSince = 0;

      if (page.quizItemCount >= 1) {
        await sleep(600);
        const still = await getTabOrThrow(tabId);

        if (still.status !== "complete" || !sameTabUrl(still.url, expectedUrl)) {
          continue;
        }

        const again = await extractPage(tabId, exclusionPhrase);

        if (again.quizItemCount >= 1 && !again.isReview) {
          return again;
        }

        continue;
      }

      if (Date.now() - lastRetryAt > 2500) {
        lastRetryAt = Date.now();
        const clicked = await sendToTab(tabId, { type: "click-retry" }).catch(() => null);
        await logEvent({
          type: "retry-click",
          url: expectedUrl,
          clicked: !!clicked?.clicked,
          label: String(clicked?.label || "").slice(0, 120)
        });
      }
    } catch (error) {
      if (/закрыта/.test(error.message)) {
        throw error;
      }
      // Страница ещё грузится.
    }

    await sleep(1000);
  }

  await logEvent({
    type: "wait-quiz-null",
    reason: "timeout",
    url: expectedUrl,
    ms: Date.now() - startedAt,
    kind: lastPage?.pageKind || "unknown",
    title: String(lastPage?.title || "").slice(0, 120)
  });
  return null;
}

function detectShuffle(prevOptions, currOptions) {
  if (!Array.isArray(prevOptions) || !Array.isArray(currOptions)) {
    return false;
  }

  const count = Math.min(prevOptions.length, currOptions.length);

  for (let i = 0; i < count; i++) {
    const a = (prevOptions[i] || []).join("|");
    const b = (currOptions[i] || []).join("|");

    if (a && b && a !== b) {
      return true;
    }
  }

  return false;
}

function baseQuizRequest(count) {
  return `Ниже тест из ${count} вопросов. Ответь по типу каждого вопроса:\n- [ОДИН ВАРИАНТ] → номер правильного варианта в скобках (целое число, отсчёт с 1).\n- [ОДИН ВАРИАНТ (выпадающий)] → тоже номер пункта в скобках.\n- [ВЫБЕРИ ВСЕ ВЕРНЫЕ] → массив номеров в скобках, напр. [1,3].\n- [ВПИШИ ОТВЕТ] → строка с ответом.\n- [ЧИСЛО] → только число, без единиц и текста (десятичная точка).\nВерни ТОЛЬКО JSON-массив из ${count} элементов в порядке вопросов, без пояснений. Пример: [1, [1,3], "AB", 2]`;
}

function retryQuizRequest(count, statuses, lastAnswers, triedList, mode) {
  const statusLine = statuses && statuses.length
    ? statuses
        .map((status, index) => {
          const prev = lastAnswers ? JSON.stringify(lastAnswers[index]) : "?";

          if (status === "correct") {
            return `Вопрос ${index + 1}: ВЕРНЫЙ (прошлый ответ ${prev}) — оставь без изменений`;
          }

          if (status === "wrong") {
            const tried = triedList && triedList[index] && triedList[index].size
              ? Array.from(triedList[index]).join("; ")
              : null;

            if (tried) {
              return `Вопрос ${index + 1}: НЕВЕРНЫЙ. Уже пробовал, и это оказалось неверно: ${tried}. Не повторяй эти варианты, выбери другой.`;
            }

            return `Вопрос ${index + 1}: НЕВЕРНЫЙ (прошлый ответ ${prev}) — выбери другой вариант`;
          }

          return `Вопрос ${index + 1}: статус неизвестен (прошлый ${prev}) — перепроверь`;
        })
        .join("\n")
    : "";

  return `Ты уже отвечал на этот тест и НЕ прошёл. Твои прошлые ответы и результат указаны выше.\nСтатусы по вопросам:\n${statusLine || "неизвестны"}\n\nПравила: не повторяй варианты, которые уже были неверными; для вопросов со статусом ВЕРНЫЙ оставь тот же ответ; учитывай обратную связь со страницы результатов.\nВерни ТОЛЬКО JSON-массив из ${count} элементов в порядке вопросов.\nФормат: [ОДИН ВАРИАНТ] → номер в скобках (отсчёт с 1), [ОДИН ВАРИАНТ (выпадающий)] → номер пункта в скобках, [ВЫБЕРИ ВСЕ ВЕРНЫЕ] → массив номеров в скобках, [ВПИШИ ОТВЕТ] → строка, [ЧИСЛО] → только число без единиц. Пример: [1, [1,3], "AB", 2]`;
}

async function extractFullText(tabId) {
  try {
    const response = await sendToTab(tabId, { type: "extract-full-text" });
    if (response?.ok) {
      return response.page;
    }
  } catch {
    // sendToTab уже пробовал инжектить скрипты.
  }

  return null;
}

async function getQuestionStatuses(tabId) {
  try {
    const response = await sendToTab(tabId, { type: "get-question-statuses" });
    if (response?.ok) {
      return response.statuses;
    }
  } catch {
    // sendToTab уже пробовал инжектить скрипты.
  }

  return [];
}

function hashText(value) {
  let first = 0x811c9dc5;
  let second = 0x01000193;
  const text = String(value || "");

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    first ^= code;
    first = Math.imul(first, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }

  return first.toString(16).padStart(8, "0") + second.toString(16).padStart(8, "0");
}

function normalizeHistoryText(value) {
  return String(value == null ? "" : value)
    .toLowerCase()
    .replace(/question\s*\d+/g, " ")
    .replace(/\b\d+\s*\/\s*\d+\s*points?\b/g, " ")
    .replace(/\b\d+\s*points?\b/g, " ")
    .replace(/^\s*\d+\s*[.)]\s*/, "")
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?"'`()\[\]{}]/g, "")
    .trim();
}

function answerToHistoryTexts(answer, options) {
  const list = Array.isArray(answer) ? answer : [answer];

  return list
    .map((value) => {
      if (typeof value === "number" && options && options[value - 1]) {
        return options[value - 1];
      }

      return String(value == null ? "" : value);
    })
    .map((value) => value.trim())
    .filter(Boolean);
}

function enforceBans(page, answers, bannedSets, locked) {
  const options = page.quizOptions || [];
  const types = page.quizTypes || [];

  answers.forEach((answer, index) => {
    if (locked && locked.has(index)) {
      return;
    }

    const banned = bannedSets[index];

    if (!banned || !banned.size) {
      return;
    }

    const bannedNorm = new Set(Array.from(banned).map(normalizeHistoryText));
    const list = options[index] || [];
    const chosen = answerToHistoryTexts(answer, list).map(normalizeHistoryText).filter(Boolean);

    if (!chosen.length || !chosen.every((text) => bannedNorm.has(text))) {
      return;
    }

    const free = list
      .map((text, optionIndex) => ({ text, optionIndex }))
      .filter(({ text }) => !bannedNorm.has(normalizeHistoryText(text)));

    if (!free.length) {
      return;
    }

    answers[index] = types[index] === "checkbox" ? [free[0].optionIndex + 1] : free[0].optionIndex + 1;
  });
}

function addBanned(entry, texts) {
  const seen = new Set((entry.banned || []).map(normalizeHistoryText));

  for (const text of texts) {
    const key = normalizeHistoryText(text);

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    entry.banned.push(String(text).trim());
  }
}

function quizHistoryKey(page) {
  // URL попытки меняется на каждом Retake, поэтому в ключ его не берём.
  const questions = (page?.quizQuestions || [])
    .map(normalizeHistoryText)
    .filter(Boolean)
    .sort()
    .join("|");

  return QUIZ_HISTORY_PREFIX + hashText(`${page?.title || ""}|${questions}|${page?.quizItemCount || 0}`);
}

async function loadQuizHistory(page) {
  const key = quizHistoryKey(page);
  const stored = await chrome.storage.local.get(key).catch(() => ({}));
  const data = stored[key];

  if (data && data.byQuestion) {
    return { key, data };
  }

  return { key, data: { byQuestion: {}, updated: 0 } };
}

async function saveQuizHistory(page, data) {
  const key = quizHistoryKey(page);
  data.updated = Date.now();
  await chrome.storage.local.set({ [key]: data }).catch(() => {});
}

function historyEntry(data, question) {
  const key = normalizeHistoryText(question);

  if (!key) {
    return null;
  }

  if (!data.byQuestion[key]) {
    data.byQuestion[key] = { banned: [], correct: false, attempts: 0 };
  }

  return data.byQuestion[key];
}

async function getAnsweredQuiz(tabId) {
  try {
    const response = await sendToTab(tabId, { type: "get-answered-quiz" });
    if (response?.ok && Array.isArray(response.answers)) {
      return response.answers;
    }
  } catch {
    // sendToTab уже пробовал инжектить скрипты.
  }

  return [];
}

async function solveQuiz(settings, page, lastAnswers, reviewPage, statuses, triedList, mode) {
  const looksReview = !!(reviewPage && isReviewPage(reviewPage.html || reviewPage.text || ""));
  const hasReview = !!((statuses && statuses.length) || looksReview || lastAnswers);

  if (hasReview) {
    const combinedHtml = [
      lastAnswers
        ? `ПРОШЛЫЕ ОТВЕТЫ (JSON): ${JSON.stringify(lastAnswers)}`
        : "ПРОШЛЫЕ ОТВЕТЫ: не сохранились. Определи неверные вопросы по странице с результатами ниже.",
      looksReview ? "СТРАНИЦА С РЕЗУЛЬТАТАМИ:\n" + (reviewPage.text || reviewPage.html || "") : "",
      "НОВЫЙ ТЕСТ:",
      page.html
    ]
      .filter(Boolean)
      .join("\n\n");

    const combinedPage = {
      title: page.title,
      url: page.url,
      html: combinedHtml,
      images: page.images,
      quizItemCount: page.quizItemCount,
      quizTypes: page.quizTypes || []
    };

    // Pro не видит картинки: если они есть, ретрай идёт через flash.
    const ask = pageHasImages(page) ? askDeepSeekForAnswers : askProForAnswers;

    return await ask(
      settings,
      combinedPage,
      "Решай тест. Учитывай прошлые ответы и обратную связь, исправляй ошибки.",
      retryQuizRequest(page.quizItemCount, statuses, lastAnswers, triedList, mode),
      page.quizItemCount
    );
  }

  return await askDeepSeekForAnswers(
    settings,
    page,
    "Решай тест. Для каждого вопроса дай ответ строго по его типу.",
    baseQuizRequest(page.quizItemCount),
    page.quizItemCount
  );
}

async function getQuizResult(tab) {
  try {
    const response = await sendToTab(tab.id, { type: "get-quiz-result" });
    return response?.ok
      ? response.result
      : { passed: false, failed: false, grade: null, threshold: null, signature: "", hasSubmitControls: false };
  } catch {
    return { passed: false, failed: false, grade: null, threshold: null, signature: "", hasSubmitControls: false };
  }
}

async function waitForQuizResult(tab, previous = {}, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  const previousSignature = previous.signature || "";
  const hadSubmitControls = !!previous.hasSubmitControls;

  while (Date.now() < deadline) {
    const tabState = await chrome.tabs.get(tab.id).catch(() => null);

    if (!tabState) {
      break;
    }

    const result = await getQuizResult(tab);
    const changed = result.signature !== previousSignature || (hadSubmitControls && !result.hasSubmitControls);

    if ((result.passed || result.failed) && (changed || !previousSignature)) {
      return result;
    }

    await sleep(1000);
  }

  return { passed: false, failed: false, grade: null, threshold: null, signature: "", hasSubmitControls: false };
}

async function applyAndSubmit(tab, answers, page, settings) {
  const repaired = await applyWithRepair(tab.id, settings, page, answers);

  if (repaired.result.skipped.length) {
    throw new Error(
      `Отмечено ${repaired.result.applied.length} из ${repaired.result.total}. Без ответа: ${repaired.result.skipped.join(", ")}.`
    );
  }

  const submitResponse = await sendToTab(tab.id, { type: "submit-quiz" });

  if (!submitResponse?.ok) {
    throw new Error(submitResponse?.error || "Не удалось отправить тест.");
  }

  if (!submitResponse.result?.submitted) {
    throw new Error("Кнопка Submit не найдена.");
  }

  await chrome.storage.local.set({ [LAST_QUESTIONS_KEY]: page?.quizQuestions || [] });

  return {
    applied: repaired.result.applied.length,
    total: repaired.result.total,
    submitted: true,
    confirmed: !!submitResponse.result.confirmed
  };
}

async function getAssignmentLinks(tabId) {
  const response = await sendToTab(tabId, { type: "extract-assignment-links" });
  return response?.ok ? response.links || [] : [];
}

async function runAutopilotOnTab(tab, settings, exclusionPhrase, courseUrl) {
  try {
    await navigateTab(tab.id, courseUrl, { requireExact: false, timeoutMs: 12000 });
  } catch (error) {
    if (/закрыта/.test(error.message)) {
      throw error;
    }
    // Даже если страница не догрузилась, пробуем прочитать то, что уже есть.
  }

  let links = [];
  let certificate = false;
  let enteredCourse = false;
  const deadline = Date.now() + 20000;

  while (Date.now() < deadline) {
    try {
      links = await getAssignmentLinks(tab.id);

      const certResponse = await sendToTab(tab.id, { type: "dismiss-certificate" });

      if (certResponse?.ok && certResponse.result?.certificate) {
        certificate = true;
      }
    } catch {
      links = [];
    }

    if (links.length || certificate) {
      break;
    }

    if (!enteredCourse) {
      enteredCourse = true;
      const entered = await enterCourse(tab.id);

      if (entered?.clicked) {
        await logEvent({
          type: "autopilot-enter-course",
          title: tab.title,
          url: tab.url,
          action: entered.label,
          confirmed: entered.confirmed
        });
        await sleep(2500);
        continue;
      }
    }

    await sleep(2000);
  }

  const stats = {
    results: [],
    errors: 0,
    passed: 0,
    failed: 0,
    unclear: 0
  };

  if (certificate) {
    stats.results.push("курс завершён (сертификат) — пропущено");
    return stats;
  }

  if (!links.length) {
    stats.results.push("заданий не найдено (всё пройдено или страница не курс)");
    return stats;
  }

  const MAX_ATTEMPTS = 3;

  for (let i = 0; i < links.length; i++) {
    if (await isStopRequested()) {
      stats.results.push("…остановлено");
      break;
    }

    const link = links[i];

    try {
      setStatus(elements.status, `(${i + 1}/${links.length}) Открываю: ${link.label}`);

      await navigateTab(tab.id, link.url);

      let lastAnswers = null;
      let reviewPage = null;
      let statuses = [];
      let triedIndices = [];
      let triedTexts = [];
      let outcome = null;
      let outcomeKind = "unclear";

      let effectiveRetryMode = settings.retryMode === "text" ? "text" : "index";
      let previousOptions = null;

      for (let attempt = 0; attempt <= MAX_ATTEMPTS; attempt++) {
        const page = await waitForQuiz(tab.id, exclusionPhrase, link.url);

        if (!page) {
          outcome = "тест не загрузился (пропущено)";
          outcomeKind = "unclear";
          break;
        }

        if (previousOptions && detectShuffle(previousOptions, page.quizOptions || [])) {
          effectiveRetryMode = "text";
        }

        setStatus(elements.status, `(${i + 1}/${links.length}) Решаю: ${link.label} (попытка ${attempt + 1})`);

        const triedList = effectiveRetryMode === "text" ? triedTexts : triedIndices;
        const answers = await solveQuiz(settings, page, lastAnswers, reviewPage, statuses, triedList, effectiveRetryMode);

        const optionTexts = page.quizOptions || [];

        answers.forEach((answer, index) => {
          if (!triedIndices[index]) {
            triedIndices[index] = new Set();
          }
          triedIndices[index].add(JSON.stringify(answer));

          if (!triedTexts[index]) {
            triedTexts[index] = new Set();
          }

          const options = optionTexts[index] || [];
          const items = Array.isArray(answer) ? answer : [answer];

          items.forEach((value) => {
            if (typeof value === "number" && options[value - 1]) {
              triedTexts[index].add(options[value - 1]);
            }
          });
        });

        previousOptions = optionTexts;

        const beforeResult = await getQuizResult(tab);
        const applied = await applyAndSubmit(tab, answers, page, settings);

        setStatus(elements.status, `(${i + 1}/${links.length}) Жду результат…`);
        const result = await waitForQuizResult(tab, beforeResult);

        if (result.passed) {
          outcome = `пройдено (${result.grade ?? "?"}%, порог ${result.threshold ?? "?"}%)`;
          outcomeKind = "passed";
          break;
        }

        if (!result.failed) {
          outcome = `отмечено ${applied.applied}/${applied.total}, submit=${applied.submitted}${applied.confirmed ? ", подтверждено" : ""} (результат не подтверждён)`;
          outcomeKind = "unclear";
          break;
        }

        if (attempt === MAX_ATTEMPTS) {
          outcome = `не пройдено (${result.grade ?? "?"}%, порог ${result.threshold ?? "?"}%) после ${MAX_ATTEMPTS + 1} попыток`;
          outcomeKind = "failed";
          break;
        }

        lastAnswers = answers;

        try {
          reviewPage = await extractFullText(tab.id);
          statuses = await getQuestionStatuses(tab.id);
        } catch {
          reviewPage = null;
          statuses = [];
        }

        await sendToTab(tab.id, { type: "click-retry" }).catch(() => {});
        await sleep(1500);
      }

      if (outcomeKind === "passed") {
        stats.passed++;
      } else if (outcomeKind === "failed") {
        stats.failed++;
      } else {
        stats.unclear++;
      }

      stats.results.push(`${link.label}: ${outcome}`);
      await logEvent({
        type: "autopilot-link",
        title: tab.title,
        url: link.url,
        label: link.label,
        outcome,
        kind: outcomeKind
      });
    } catch (error) {
      stats.errors++;
      stats.results.push(`${link.label}: ошибка — ${error.message}`);
      await logEvent({
        type: "autopilot-link-error",
        title: tab.title,
        url: link.url,
        label: link.label,
        error: error.message
      });
    }
  }

  return stats;
}

async function getAllCourseTabs() {
  const windows = await chrome.windows.getAll({ populate: true });
  const tabs = [];

  for (const win of windows) {
    for (const tab of win.tabs || []) {
      if (tab.id && tab.url && /coursera\.org/i.test(tab.url)) {
        tabs.push(tab);
      }
    }
  }

  return tabs;
}

async function autopilotSinglePage() {
  if (!(await confirmAutopilotStart())) {
    return;
  }

  stopAutopilot = false;
  await chrome.storage.local.set({
    [STOP_REQUEST_KEY]: false,
    autopilotRunning: true,
    autopilotStartedAt: Date.now()
  });
  startHeartbeat();

  elements.autopilotSingleButton.disabled = true;
  elements.stopButton.hidden = false;
  setStatus(elements.status, "Собираю текущую вкладку…");

  try {
    const settings = await getSettings();
    const tab = await getActiveTab();
    const exclusionPhrase = settings.exclusionPhrase;

    await logEvent({
      type: "autopilot-single-start",
      title: tab.title,
      url: tab.url,
      version: chrome.runtime.getManifest().version
    });

    const run = await runAutopilotOnTab(tab, settings, exclusionPhrase, tab.url);

    renderAnswer(
      "Автопилот (1 курс) закончил:\n" +
      `Ошибок: ${run.errors}, не пройдено: ${run.failed}, неподтверждённых: ${run.unclear}, пройдено: ${run.passed}.\n— ` +
      (tab.title || tab.url) + " —\n" + run.results.join("\n")
    );

    if (run.errors) {
      setStatus(elements.status, `Завершено с ошибками: ${run.errors}.`, true);
    } else if (run.failed) {
      setStatus(elements.status, `Готово, но не пройдено: ${run.failed}.`, true);
    } else if (run.unclear) {
      setStatus(elements.status, `Готово, но результат не подтверждён: ${run.unclear}.`, true);
    } else {
      setStatus(elements.status, "Готово.");
    }

    await logEvent({
      type: "autopilot-single-end",
      version: chrome.runtime.getManifest().version,
      errors: run.errors,
      unclear: run.unclear,
      passed: run.passed,
      failed: run.failed
    });
  } catch (error) {
    setStatus(elements.status, error.message, true);
  } finally {
    stopAutopilot = false;
    stopHeartbeat();
    await chrome.storage.local.set({ autopilotRunning: false });
    elements.autopilotSingleButton.disabled = false;
    elements.stopButton.hidden = true;
  }
}

async function autopilotPage() {
  if (!(await confirmAutopilotStart())) {
    return;
  }

  stopAutopilot = false;
  await chrome.storage.local.set({
    [STOP_REQUEST_KEY]: false,
    autopilotRunning: true,
    autopilotStartedAt: Date.now()
  });
  startHeartbeat();

  elements.autopilotButton.disabled = true;
  elements.stopButton.hidden = false;
  setStatus(elements.status, "Собираю вкладки…");

  try {
    const settings = await getSettings();
    const exclusionPhrase = settings.exclusionPhrase;

    const courseTabs = await getAllCourseTabs();

    if (!courseTabs.length) {
      throw new Error("Нет открытых http-вкладок.");
    }

    await logEvent({
      type: "autopilot-start",
      tabs: courseTabs.length,
      version: chrome.runtime.getManifest().version
    });

    setStatus(elements.status, `Найдено вкладок: ${courseTabs.length}. Стартую…`);

    const allResults = [];
    const totals = { errors: 0, unclear: 0, passed: 0, failed: 0 };

    const runPass = async (label) => {
      for (let i = 0; i < courseTabs.length; i++) {
        if (await isStopRequested()) {
          break;
        }

        const tab = courseTabs[i];
        setStatus(elements.status, `${label} [${i + 1}/${courseTabs.length}]: ${tab.title || tab.url}`);

        await logEvent({ type: "autopilot-tab", pass: label, title: tab.title, url: tab.url });

        try {
          const run = await runAutopilotOnTab(tab, settings, exclusionPhrase, tab.url);

          totals.errors += run.errors;
          totals.unclear += run.unclear;
          totals.passed += run.passed;
          totals.failed += run.failed;

          allResults.push(`\n— ${tab.title || tab.url} —`);
          allResults.push(...run.results);
        } catch (error) {
          totals.errors++;
          allResults.push(`\n— ${tab.title || tab.url} —`);
          allResults.push(`ошибка — ${error.message}`);
          await logEvent({ type: "autopilot-tab-error", pass: label, title: tab.title, url: tab.url, error: error.message });
        }
      }
    };

    await runPass("Проход 1");

    if (!(await isStopRequested())) {
      await runPass("Перепроверка");
    }

    stopAutopilot = await isStopRequested();

    await logEvent({
      type: "autopilot-end",
      version: chrome.runtime.getManifest().version,
      stopped: stopAutopilot,
      errors: totals.errors,
      unclear: totals.unclear,
      passed: totals.passed,
      failed: totals.failed
    });

    const header = stopAutopilot
      ? "ОСТАНОВЛЕНО.\n"
      : `Автопилот закончил. Ошибок: ${totals.errors}, не пройдено: ${totals.failed}, неподтверждённых: ${totals.unclear}, пройдено: ${totals.passed}.\n`;

    renderAnswer(header + allResults.join("\n"));

    if (stopAutopilot) {
      setStatus(elements.status, "Остановлено.");
    } else if (totals.errors) {
      setStatus(elements.status, `Завершено с ошибками: ${totals.errors}.`, true);
    } else if (totals.failed) {
      setStatus(elements.status, `Готово, но не пройдено: ${totals.failed}.`, true);
    } else if (totals.unclear) {
      setStatus(elements.status, `Готово, но результат не подтверждён: ${totals.unclear}.`, true);
    } else {
      setStatus(elements.status, "Готово.");
    }
  } catch (error) {
    setStatus(elements.status, error.message, true);
  } finally {
    stopAutopilot = false;
    stopHeartbeat();
    await chrome.storage.local.set({ autopilotRunning: false });
    elements.autopilotButton.disabled = false;
    elements.stopButton.hidden = true;
  }
}

async function sendCurrentPage() {
  elements.sendButton.disabled = true;
  setStatus(elements.status, "Читаю и очищаю body…");

  try {
    const [settings, tab] = await Promise.all([
      getSettings(),
      getActiveTab()
    ]);
    const page = await extractPage(tab.id, settings.exclusionPhrase || "");

    setStatus(
      elements.status,
      page.wasTruncated ? "Отправляю в DeepSeek (страница обрезана)…" : "Отправляю в DeepSeek…"
    );

    const response = await chrome.runtime.sendMessage({
      type: "ask-deepseek",
      payload: {
        apiKey: settings.apiKey,
        model: settings.model,
        instruction: settings.instruction,
        page,
        request: "Прочитай очищенный HTML-каркас страницы и дай полезный ответ согласно постоянной инструкции."
      }
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Не удалось получить ответ DeepSeek.");
    }

    renderAnswer(response.answer);
    setStatus(elements.status, "Готово.");
  } catch (error) {
    setStatus(elements.status, error.message, true);
  } finally {
    elements.sendButton.disabled = false;
  }
}

async function downloadLog() {
  const stored = await chrome.storage.local.get("logs");
  const logs = stored.logs || [];

  const text = logs
    .map((entry) => {
      const line = { ...entry };
      delete line.time;
      return `[${entry.time}] ${JSON.stringify(line)}`;
    })
    .join("\n");

  const blob = new Blob([text || "лог пуст"], { type: "text/plain" });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `deepseek-log-${Date.now()}.txt`;
  anchor.click();

  setTimeout(() => URL.revokeObjectURL(url), 2000);
  setStatus(elements.status, `Лог выгружен (${logs.length} записей).`);
}

async function clearLog() {
  const all = await chrome.storage.local.get(null);
  const cacheKeys = Object.keys(all).filter(
    (key) => key.startsWith("ac:") || key.startsWith(QUIZ_HISTORY_PREFIX) || key === "answerCache"
  );

  if (cacheKeys.length) {
    await chrome.storage.local.remove(cacheKeys);
  }

  await chrome.storage.local.set({ logs: [] });
  setStatus(elements.status, "Лог и кэш ответов очищены.");
}

elements.sendButton.addEventListener("click", sendCurrentPage);
elements.autoFillButton.addEventListener("click", autoFillPage);
elements.retryButton.addEventListener("click", retryPage);
elements.assignmentButton.addEventListener("click", fillAssignmentPage);
elements.autopilotButton.addEventListener("click", autopilotPage);
elements.autopilotSingleButton.addEventListener("click", autopilotSinglePage);
elements.reviewButton.addEventListener("click", reviewPage);
elements.previewButton.addEventListener("click", previewCurrentPage);
elements.copyCleanButton.addEventListener("click", downloadCleanPage);
elements.downloadLogButton.addEventListener("click", () => downloadLog().catch((error) => setStatus(elements.status, error.message, true)));
elements.clearLogButton.addEventListener("click", () => clearLog().catch((error) => setStatus(elements.status, error.message, true)));
elements.stopButton.addEventListener("click", () => {
  stopAutopilot = true;
  chrome.storage.local.set({ [STOP_REQUEST_KEY]: true });
  setStatus(elements.status, "Останавливаю…");
});
elements.settingsButton.addEventListener("click", () => showSettings(true));
elements.backButton.addEventListener("click", () => showSettings(false));
elements.saveButton.addEventListener("click", saveSettings);

async function runControlAction() {
  if (!CONTROL_ACTION) {
    return;
  }

  if (CONTROL_ACTION === "stop") {
    stopAutopilot = true;
    await chrome.storage.local.set({ [STOP_REQUEST_KEY]: true });
    setStatus(elements.status, "Остановлено из монитора.");
    return;
  }

  if (CONTROL_ACTION === "reload") {
    stopAutopilot = true;
    await chrome.storage.local.set({
      [STOP_REQUEST_KEY]: false,
      autopilotRunning: false
    });
    setStatus(elements.status, "Перезагружаю расширение…");
    setTimeout(() => chrome.runtime.reload(), 400);
    return;
  }

  if (CONTROL_ACTION === "start") {
    await autopilotPage();
  }
}

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  logEvent({ type: "panel-unhandled", error: String(reason?.message || reason || "rejection") }).catch(() => {});
});

window.addEventListener("error", (event) => {
  logEvent({ type: "panel-error", error: String(event.message || "error") }).catch(() => {});
});

initialize()
  .then(runControlAction)
  .catch((error) => setStatus(elements.status, error.message, true));
