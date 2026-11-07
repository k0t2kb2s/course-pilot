const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("replaces the old content-script listener when reinjected", () => {
  const listeners = [];
  const removed = [];
  const context = {
    chrome: {
      runtime: {
        onMessage: {
          addListener: (listener) => listeners.push(listener),
          removeListener: (listener) => removed.push(listener)
        }
      }
    },
    globalThis: null
  };

  context.globalThis = context;
  vm.createContext(context);

  const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  vm.runInContext(source, context);
  vm.runInContext(source, context);

  assert.equal(listeners.length, 2);
  assert.equal(removed.length, 1);
  assert.equal(removed[0], listeners[0]);
  assert.equal(context.__pageToDeepSeekExtractorListener, listeners[1]);
});
