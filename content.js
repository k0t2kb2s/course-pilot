(() => {
  "use strict";

  if (globalThis.__pageToDeepSeekExtractorInstalled) {
    if (globalThis.__pageToDeepSeekExtractorListener) {
      chrome.runtime.onMessage.removeListener(globalThis.__pageToDeepSeekExtractorListener);
    }
  }

  globalThis.__pageToDeepSeekExtractorInstalled = true;

  const listener = (message, _sender, sendResponse) => {
    if (message.type === "extract-clean-page") {
      try {
        const page = globalThis.PageCleaner.cleanCurrentPage(
          message.exclusionPhrase,
          message.characterLimit
        );
        sendResponse({ ok: true, page });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }

      return;
    }

    if (message.type === "apply-quiz-answers") {
      try {
        const result = globalThis.PageCleaner.applyQuizAnswers(
          message.answers || [],
          message.questions || [],
          message.types || []
        );
        sendResponse({ ok: true, result });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }

      return;
    }

    if (message.type === "click-retry") {
      try {
        const result = globalThis.PageCleaner.clickRetryButton();
        sendResponse({ ok: true, clicked: !!result?.clicked, label: result?.label || "" });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }

      return;
    }

    if (message.type === "enter-course") {
      globalThis.PageCleaner.enterCourse()
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));

      return true;
    }

    if (message.type === "submit-quiz") {
      globalThis.PageCleaner.submitQuiz()
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));

      return true;
    }

    if (message.type === "extract-assignment") {
      try {
        const page = globalThis.PageCleaner.extractAssignmentText();
        sendResponse({ ok: true, page });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }

      return;
    }

    if (message.type === "fill-answer") {
      try {
        const texts = Array.isArray(message.texts) ? message.texts : [message.text || ""];
        const result = globalThis.PageCleaner.fillAnswerEditors(texts);
        sendResponse({ ok: true, result });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }

      return;
    }

    if (message.type === "extract-assignment-links") {
      try {
        const links = globalThis.PageCleaner.extractAssignmentLinks();
        sendResponse({ ok: true, links });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }

      return;
    }

    if (message.type === "get-quiz-result") {
      try {
        const result = globalThis.PageCleaner.getQuizResult();
        sendResponse({ ok: true, result });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }

      return;
    }

    if (message.type === "extract-full-text") {
      try {
        const page = globalThis.PageCleaner.extractFullText();
        sendResponse({ ok: true, page });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }

      return;
    }

    if (message.type === "get-question-statuses") {
      try {
        const statuses = globalThis.PageCleaner.getQuestionStatuses();
        sendResponse({ ok: true, statuses });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }

      return;
    }

    if (message.type === "get-answered-quiz") {
      try {
        const answers = globalThis.PageCleaner.getAnsweredQuiz();
        sendResponse({ ok: true, answers });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }

      return;
    }

    if (message.type === "click-my-submission") {
      try {
        const clicked = globalThis.PageCleaner.clickMySubmission();
        sendResponse({ ok: true, clicked });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }

      return;
    }

    if (message.type === "detect-assignment-type") {
      try {
        const type = globalThis.PageCleaner.detectAssignmentType();
        sendResponse({ ok: true, type });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }

      return;
    }

    if (message.type === "dismiss-certificate") {
      try {
        const result = globalThis.PageCleaner.dismissBlockingModals();
        sendResponse({ ok: true, result });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }

      return;
    }

    if (message.type === "complete-peer-review") {
      try {
        const result = globalThis.PageCleaner.completePeerReview(message.feedbackText);
        sendResponse({ ok: true, result });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }

      return;
    }

    if (message.type === "submit-review") {
      try {
        const clicked = globalThis.PageCleaner.clickSubmitReview();
        sendResponse({ ok: true, clicked });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }

      return;
    }

    if (message.type === "get-review-count") {
      try {
        const count = globalThis.PageCleaner.getReviewCount();
        sendResponse({ ok: true, count });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
    }
  };

  globalThis.__pageToDeepSeekExtractorListener = listener;
  chrome.runtime.onMessage.addListener(listener);
})();
