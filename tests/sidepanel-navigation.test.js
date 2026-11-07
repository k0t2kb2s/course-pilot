const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function element() {
  return {
    addEventListener() {},
    classList: { toggle() {} },
    hidden: false,
    value: "",
    textContent: "",
    disabled: false,
    click() {}
  };
}

function loadSidepanel(chrome) {
  const context = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
    chrome,
    location: { search: "" },
    document: {
      querySelector: () => element(),
      querySelectorAll: () => [],
      createElement: () => element()
    },
    Blob: class {},
    globalThis: null
  };

  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "sidepanel.js"), "utf8"), context);
  return context;
}

function chromeStub(overrides = {}) {
  const base = {
    storage: { local: { get: async () => ({}), set: async () => {} } },
    scripting: { executeScript: async () => {} },
    tabs: {
      get: async () => ({ id: 1, url: "https://www.coursera.org/learn/a/quiz", status: "complete" }),
      update: async () => {},
      sendMessage: async () => ({ ok: true }),
      query: async () => []
    },
    runtime: { sendMessage: async () => ({ ok: true, answer: "[]" }) },
    windows: { getAll: async () => [] }
  };

  return {
    ...base,
    ...overrides,
    tabs: { ...base.tabs, ...overrides.tabs },
    scripting: overrides.scripting || base.scripting
  };
}

test("does not navigate when the tab is already on the target URL", async () => {
  let updates = 0;
  const chrome = chromeStub({
    tabs: {
      get: async () => ({ id: 1, url: "https://www.coursera.org/learn/a/quiz", status: "complete" }),
      update: async () => { updates++; },
      sendMessage: async () => ({ ok: true })
    }
  });
  const context = loadSidepanel(chrome);

  await context.navigateTab(1, "https://www.coursera.org/learn/a/quiz");

  assert.equal(updates, 0);
});

test("reloads a discarded tab even when the URL already matches", async () => {
  let updates = 0;
  let tab = { id: 1, url: "https://www.coursera.org/learn/a/quiz", status: "unloaded" };

  const chrome = chromeStub({
    tabs: {
      get: async () => tab,
      update: async () => {
        updates++;
        tab = { id: 1, url: tab.url, status: "complete" };
      },
      sendMessage: async () => ({ ok: true })
    }
  });
  const context = loadSidepanel(chrome);

  await context.navigateTab(1, "https://www.coursera.org/learn/a/quiz");

  assert.equal(updates, 1);
});

test("waits for a duplicate navigation instead of issuing it again", async () => {
  let updates = 0;
  let tab = {
    id: 1,
    url: "https://www.coursera.org/learn/a/old",
    pendingUrl: "https://www.coursera.org/learn/a/quiz",
    status: "loading"
  };

  const chrome = chromeStub({
    tabs: {
      get: async () => tab,
      update: async () => {
        updates++;
        throw new Error("Navigation rejected.");
      },
      sendMessage: async () => ({ ok: true })
    }
  });
  const context = loadSidepanel(chrome);

  setTimeout(() => {
    tab = { id: 1, url: "https://www.coursera.org/learn/a/quiz", status: "complete" };
  }, 100);

  const result = await context.navigateTab(1, "https://www.coursera.org/learn/a/quiz");

  assert.equal(updates, 1);
  assert.equal(result.url, "https://www.coursera.org/learn/a/quiz");
});

test("retries a rejected navigation once when nothing is loading", async () => {
  let updates = 0;
  let tab = { id: 1, url: "https://www.coursera.org/learn/a/old", status: "complete" };

  const chrome = chromeStub({
    tabs: {
      get: async () => tab,
      update: async (_id, details) => {
        updates++;
        if (updates === 1) {
          throw new Error("Navigation rejected.");
        }
        tab = { id: 1, url: details.url, status: "complete" };
      },
      sendMessage: async () => ({ ok: true })
    }
  });
  const context = loadSidepanel(chrome);

  const result = await context.navigateTab(1, "https://www.coursera.org/learn/a/quiz");

  assert.equal(updates, 2);
  assert.equal(result.url, "https://www.coursera.org/learn/a/quiz");
});

test("accepts a redirected page when an exact URL is not required", async () => {
  let tab = { id: 1, url: "https://www.coursera.org/learn/a/old", status: "complete" };

  const chrome = chromeStub({
    tabs: {
      get: async () => tab,
      update: async () => {
        tab = { id: 1, url: "https://www.coursera.org/learn/a/canonical", status: "complete" };
      },
      sendMessage: async () => ({ ok: true })
    }
  });
  const context = loadSidepanel(chrome);

  const result = await context.navigateTab(1, "https://www.coursera.org/learn/a/quiz", { requireExact: false });

  assert.equal(result.url, "https://www.coursera.org/learn/a/canonical");
});

test("opens /attempt directly instead of solving a review page", async () => {
  let tab = {
    id: 1,
    url: "https://www.coursera.org/learn/a/quiz/view-feedback",
    status: "complete"
  };
  let updates = 0;

  const chrome = chromeStub({
    tabs: {
      get: async () => tab,
      update: async (_id, details) => {
        updates++;
        tab = { id: 1, url: details.url, status: "complete" };
      },
      sendMessage: async () => {
        const onAttempt = tab.url.endsWith("/attempt");
        return {
          ok: true,
          page: onAttempt
            ? { isReview: false, quizItemCount: 3, quizOptions: [[], [], []] }
            : { isReview: true, quizItemCount: 1, quizOptions: [[]] }
        };
      }
    }
  });
  const context = loadSidepanel(chrome);

  const page = await context.waitForQuiz(1, "", "https://www.coursera.org/learn/a/quiz", 5000);

  assert.equal(updates, 1);
  assert.equal(tab.url, "https://www.coursera.org/learn/a/quiz/attempt");
  assert.equal(page.quizItemCount, 3);
  assert.equal(page.isReview, false);
});

test("does not accept the old review URL as /attempt before navigation commits", async () => {
  let tab = {
    id: 1,
    url: "https://www.coursera.org/learn/a/quiz/view-feedback",
    status: "complete"
  };

  const chrome = chromeStub({
    tabs: {
      get: async () => tab,
      update: async (_id, details) => {
        setTimeout(() => {
          tab = { id: 1, url: details.url, status: "complete" };
        }, 100);
      },
      sendMessage: async () => ({ ok: true })
    }
  });
  const context = loadSidepanel(chrome);

  const result = await context.navigateTab(
    1,
    "https://www.coursera.org/learn/a/quiz/attempt",
    { force: true, exactPath: true }
  );

  assert.equal(result.url, "https://www.coursera.org/learn/a/quiz/attempt");
});

test("reinjects the content script after a lost receiving end", async () => {
  let sends = 0;
  let injections = 0;

  const chrome = chromeStub({
    tabs: {
      get: async () => ({ id: 1, url: "https://www.coursera.org/learn/a/quiz", status: "complete" }),
      update: async () => {},
      sendMessage: async () => {
        sends++;
        if (sends === 1) {
          throw new Error("Could not establish connection. Receiving end does not exist.");
        }
        return { ok: true, value: 42 };
      }
    },
    scripting: {
      executeScript: async () => { injections++; }
    }
  });
  const context = loadSidepanel(chrome);

  const response = await context.sendToTab(1, { type: "test" });

  assert.equal(response.value, 42);
  assert.equal(sends, 2);
  assert.equal(injections, 1);
});

test("does not retry when the tab is gone", async () => {
  let sends = 0;
  const chrome = chromeStub({
    tabs: {
      get: async () => ({ id: 1, url: "https://www.coursera.org/learn/a/quiz", status: "complete" }),
      update: async () => {},
      sendMessage: async () => {
        sends++;
        throw new Error("No tab with id: 1.");
      }
    }
  });
  const context = loadSidepanel(chrome);

  await assert.rejects(() => context.sendToTab(1, { type: "test" }), /No tab with id/);
  assert.equal(sends, 1);
});

test("ignores the old result banner until the result changes", async () => {
  const oldResult = {
    passed: false,
    failed: true,
    grade: 70,
    threshold: 80,
    signature: "old",
    hasSubmitControls: true
  };
  const newResult = {
    passed: true,
    failed: false,
    grade: 80,
    threshold: 80,
    signature: "new",
    hasSubmitControls: false
  };
  let reads = 0;

  const chrome = chromeStub({
    tabs: {
      get: async () => ({ id: 1, url: "https://www.coursera.org/learn/a/quiz", status: "complete" }),
      update: async () => {},
      sendMessage: async () => {
        reads++;
        return { ok: true, result: reads < 3 ? oldResult : newResult };
      }
    }
  });
  const context = loadSidepanel(chrome);

  const result = await context.waitForQuizResult({ id: 1 }, oldResult, 5000);

  assert.equal(result.passed, true);
  assert.equal(result.grade, 80);
  assert.ok(reads >= 3);
});
