# CoursePilot

> A Chrome side-panel autopilot for Coursera. Drop it next to a course, hit one button, and it works through the quizzes, or hands you a clean task export when you want to solve something yourself.

![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)
![No build step](https://img.shields.io/badge/build-none-3fd68a)
![Local only](https://img.shields.io/badge/privacy-local--only-7c5cff)
![License](https://img.shields.io/badge/license-MIT-8b93a8)

<p align="center">
  <img src="docs/panel.svg" alt="CoursePilot side panel" width="360">
</p>

[English](#english) · [Русский](#русский)

---

## English

### What it is

A side panel that opens next to any Coursera tab. It reads the page, keeps only the real questions, sends them to an LLM, and writes the answers straight back into the page: radio, checkbox, text and dropdown inputs alike.

No server, no account, no build step. Load it and go.

### Why

Because clicking through forty quizzes is not learning. A person should read, argue, and build; the clicking is just overhead. This tool removes the overhead and leaves the thinking.

### Features

| | |
| --- | --- |
| **Autopilot · all tabs** | Walks every open Coursera tab, solves each assignment, submits, retries until it passes, then does a verification pass. |
| **Autopilot · one course** | Same run, current tab only. |
| **Auto-fill** | Solves a single quiz in place. |
| **Retry** | After a failed attempt it reads the review feedback, retakes the quiz, and only changes the wrong answers. |
| **Fill assignment** | Detects the task type (quiz / rich-text / file upload) and handles it. |
| **Peer review** | Fills rubric ratings and comments and submits each pending review. |
| **Download HTML** | Exports a clean, self-contained page with the questions **and images**, so you can solve a hard task yourself. |
| **Answer cache** | Identical requests are answered from a local cache: no repeat API calls, no tokens. |
| **Logs** | Every action and API call is logged locally; export the log in one click. |

### Quick start

1. Open `chrome://extensions` and enable **Developer mode**.
2. **Load unpacked** → pick this folder.
3. Click the toolbar icon to open the side panel.
4. Open the settings (gear) and paste your DeepSeek API key.
5. Open a Coursera course tab and hit **Запустить автопилот**.

The key is stored only in `chrome.storage.local`. Nothing is baked into the source.

### How to use it

| Button | When to use it |
| --- | --- |
| **Запустить автопилот** | You have several course tabs open and want them done in one go. |
| **Текущий курс** | You only care about the tab in front of you. |
| **Авто-заполнить** | One quiz, fill it now. |
| **Повторить** | You submitted, failed, and want the wrong answers fixed. |
| **Заполнить задание** | A rich-text homework or a file-upload assignment. |
| **Выполнить ревью** | You owe peer reviews and don't want to click through them. |
| **Скачать HTML** | The task is too hard for the model; export it and solve it yourself. |

### How it works

```
sidepanel.js ──► content.js ──► page-cleaner.js   (read + fill the DOM)
     │
     └────────► background.js ──► api.deepseek.com   (configurable model)
```

- **`page-cleaner.js`**: extracts quiz items, options, images, links and review feedback; strips in-page AI boilerplate before anything leaves the browser.
- **`content.js`**: the bridge between the panel and the page.
- **`sidepanel.js`**: the UI and the autopilot / retry / review logic.
- **`background.js`**: API calls, image encoding, caching, retries, and a single global request queue so parallel runs don't trip rate limits.

### What's inside

```
background.js     API calls, cache, retries, request queue
content.js        page ⇄ panel bridge
page-cleaner.js   extract + fill the DOM
sidepanel.*       the UI and the autopilot logic
tests/            node --test, 20 passing
docs/panel.svg    the screenshot above
```

### FAQ

**Does it work on mobile?** No. It's a Chrome side panel.
**Will it fix my degree?** It fixes the quiz. The degree is still on you.
**Why are the buttons in Russian?** Because the author is.
**Why does it strip "You are a helpful AI assistant…"?** That boilerplate is injected into some assessment pages to confuse assistants; the model never sees it.
**Is my key safe?** It lives in `chrome.storage.local`, on your machine, and goes only to `api.deepseek.com`.

### Roadmap

- [x] Autopilot across all tabs
- [x] Retry until it passes
- [x] Peer-review automation
- [x] Local answer cache
- [ ] In-video quizzes
- [ ] Provider switch in the UI

### Privacy

Everything runs locally. No server, no analytics, no third-party storage. The API key lives in `chrome.storage.local` and is only sent to `api.deepseek.com`.

### Limitations

- Hard symbolic / math assignments depend on the model and can still fail.
- In-video quizzes are not automated.
- Coursera changes its DOM from time to time, so selectors may need a touch-up.

---

## Русский

### Что это

Боковая панель в Chrome, которая открывается рядом с любой вкладкой Coursera. Она читает страницу, оставляет только реальные вопросы, отправляет их модели и вписывает ответы обратно: radio, checkbox, текстовые поля и выпадающие списки.

Без сервера, без аккаунта, без сборки. Загрузил, и работает.

### Зачем

Потому что прощёлкивать сорок тестов — это не учёба. Человек должен читать, спорить и строить; клики — просто накладные расходы. Инструмент убирает их и оставляет мышление.

### Возможности

| | |
| --- | --- |
| **Автопилот · все вкладки** | Проходит все открытые вкладки Coursera, решает каждое задание, отправляет, добивает ретраем до прохода и делает перепроверку. |
| **Автопилот · один курс** | То же, но только текущая вкладка. |
| **Авто-заполнить** | Решает один тест на месте. |
| **Повторить** | После провала читает фидбек, перепроходит и меняет только неверные ответы. |
| **Заполнить задание** | Определяет тип задания (квиз / rich-text / загрузка файла) и обрабатывает. |
| **Выполнить ревью** | Ставит оценки по рубрике, пишет комментарии и отправляет ревью. |
| **Скачать HTML** | Сохраняет чистую страницу с вопросами **и картинками**, чтобы решить сложное вручную. |
| **Кэш ответов** | Одинаковые запросы берутся из локального кэша: без повторных вызовов API и токенов. |
| **Логи** | Каждое действие и вызов API пишутся локально; лог выгружается одной кнопкой. |

### Быстрый старт

1. Открой `chrome://extensions`, включи **Режим разработчика**.
2. **Загрузить распакованное** → выбери эту папку.
3. Нажми на иконку расширения, откроется боковая панель.
4. В настройках (шестерёнка) вставь свой ключ DeepSeek.
5. Открой вкладку курса Coursera и нажми **Запустить автопилот**.

Ключ хранится только в `chrome.storage.local`. В исходниках его нет.

### Как пользоваться

| Кнопка | Когда нажимать |
| --- | --- |
| **Запустить автопилот** | Открыто несколько курсов, нужно пройти всё разом. |
| **Текущий курс** | Нужна только вкладка перед тобой. |
| **Авто-заполнить** | Один тест, заполнить сейчас. |
| **Повторить** | Отправил, провалил, исправить неверные ответы. |
| **Заполнить задание** | Домашка текстом или задание с загрузкой файла. |
| **Выполнить ревью** | Надо закрыть чужие peer review. |
| **Скачать HTML** | Задача слишком сложная: выгрузи и реши сам. |

### Как это работает

```
sidepanel.js ──► content.js ──► page-cleaner.js   (читает и заполняет DOM)
     │
     └────────► background.js ──► api.deepseek.com   (модель настраивается)
```

- **`page-cleaner.js`**: вытаскивает вопросы, варианты, картинки, ссылки и фидбек; вырезает встроенные «ИИ-инструкции» до того, как что-то покинет браузер.
- **`content.js`**: мост между панелью и страницей.
- **`sidepanel.js`**: интерфейс и логика автопилота / ретрая / ревью.
- **`background.js`**: вызовы API, кодирование картинок, кэш, ретраи и одна общая очередь, чтобы параллельные прогоны не ловили 429.

### Что внутри

```
background.js     вызовы API, кэш, ретраи, очередь
content.js        мост страница ⇄ панель
page-cleaner.js   извлечение и заполнение DOM
sidepanel.*       интерфейс и логика автопилота
tests/            node --test, 20 проходят
docs/panel.svg    скриншот выше
```

### Вопросы

**Работает на телефоне?** Нет, это боковая панель Chrome.
**Закроет мне диплом?** Тест закроет. Диплом сам.
**Почему кнопки на русском?** Потому что автор русский.
**Зачем вырезать «You are a helpful AI assistant…»?** Этот текст подсовывают в некоторые страницы тестов, чтобы сбить ассистента; модель его не видит.
**Ключ в безопасности?** Он лежит в `chrome.storage.local`, у тебя на машине, и уходит только на `api.deepseek.com`.

### Планы

- [x] Автопилот по всем вкладкам
- [x] Ретрай до прохода
- [x] Автоматизация peer review
- [x] Локальный кэш ответов
- [ ] In-video тесты
- [ ] Переключение провайдера в интерфейсе

### Приватность

Всё локально. Ни сервера, ни аналитики, ни стороннего хранения. Ключ живёт в `chrome.storage.local` и уходит только на `api.deepseek.com`.

### Ограничения

- Сложные символьные/математические задания зависят от модели и могут не пройти.
- In-video тесты не автоматизируются.
- Coursera периодически меняет DOM, селекторы могут потребовать правки.

---

<p align="center"><sub>Built by <a href="https://obs1d1an.tech">obs1d1an</a> · MIT · no servers were harmed</sub></p>
