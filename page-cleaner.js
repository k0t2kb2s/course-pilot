(function exposePageCleaner(global) {
  "use strict";

  const REMOVABLE_ELEMENTS = new Set([
    "script",
    "style",
    "noscript",
    "template",
    "link",
    "meta",
    "iframe",
    "object",
    "embed",
    "canvas",
    "svg",
    "video",
    "audio",
    "source"
  ]);

  const PRESERVED_ATTRIBUTES = new Set([
    "name",
    "type",
    "role",
    "alt",
    "href",
    "src",
    "for",
    "placeholder",
    "aria-label",
    "aria-labelledby",
    "aria-describedby",
    "aria-expanded",
    "aria-current"
  ]);

  const VOID_ELEMENTS = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"
  ]);

  const EMPTY_ELEMENTS_TO_DROP = new Set([
    "article", "aside", "div", "li", "main", "p", "section", "span"
  ]);

  const BUILT_IN_BOILERPLATE = [
    /You are a helpful AI assistant[\s\S]*?Do you understand\?\.\s*(?:I understand\s*)?/gi,
    /You are an AI assistant[\s\S]*?Do you understand\?\.\s*(?:I understand\s*)?/gi
  ];

  function stripBuiltInBoilerplate(value) {
    return BUILT_IN_BOILERPLATE.reduce((text, pattern) => text.replace(pattern, ""), value);
  }

  function dropEmptyTags(html) {
    let previous;

    do {
      previous = html;
      html = html.replace(/<(article|aside|div|li|main|p|section|span)[^>]*>\s*<\/\1>/gi, "");
    } while (html !== previous);

    return html;
  }

  // Извлекает текст с формулами: KaTeX-блоки заменяются на их TeX-источник,
  // визуальный мусор и дубли (visually-hidden) убираются.
  function mathAwareText(root) {
    if (!root) {
      return "";
    }

    const clone = root.cloneNode(true);

    clone.querySelectorAll("math").forEach((mathElement) => {
      const annotation = mathElement.querySelector('annotation[encoding="application/x-tex"]');
      const tex = annotation ? annotation.textContent.trim() : "";
      const span = document.createElement("span");
      span.textContent = tex ? ` ${tex} ` : " ";
      mathElement.replaceWith(span);
    });

    clone.querySelectorAll('[data-testid="visually-hidden"]').forEach((element) => element.remove());
    clone.querySelectorAll(".katex-html").forEach((element) => element.remove());

    return clone.textContent || "";
  }

  function getOptionLabel(input, exclusionPattern) {
    const labels = input.labels;

    if (labels && labels.length) {
      return cleanValue(mathAwareText(labels[0]), exclusionPattern).trim();
    }

    const id = input.getAttribute("id");

    if (id) {
      const label = document.querySelector(`label[for="${id}"]`);

      if (label) {
        return cleanValue(mathAwareText(label), exclusionPattern).trim();
      }
    }

    const wrappedLabel = input.closest("label");

    if (wrappedLabel) {
      return cleanValue(mathAwareText(wrappedLabel), exclusionPattern).trim();
    }

    const sibling = input.nextElementSibling;

    if (sibling) {
      return cleanValue(mathAwareText(sibling), exclusionPattern).trim();
    }

    return "";
  }

  function getOptionImage(input) {
    const container = input.closest("label") || input.parentElement;

    if (!container) {
      return "";
    }

    const img = container.querySelector("img");
    return img ? img.getAttribute("src") || "" : "";
  }

  function commonAncestor(elements) {
    let ancestor = elements[0].parentElement;

    while (ancestor && !elements.every((element) => ancestor.contains(element))) {
      ancestor = ancestor.parentElement;
    }

    return ancestor;
  }

  function removeOptionText(text, options) {
    let result = text;

    for (const option of options) {
      if (option.length >= 3) {
        result = result.split(option).join(" ");
      }
    }

    return result;
  }

  function extractQuestionText(radios, options, exclusionPattern) {
    const scope = commonAncestor(radios);

    const labelledBy = scope?.getAttribute("aria-labelledby");

    if (labelledBy) {
      const labelNode = document.getElementById(labelledBy);
      const labelled = cleanValue(labelNode?.textContent || "", exclusionPattern).trim();

      if (labelled) {
        return labelled;
      }
    }

    const ariaLabel = cleanValue(scope?.getAttribute("aria-label") || "", exclusionPattern).trim();

    if (ariaLabel) {
      return ariaLabel;
    }

    let sibling = scope?.previousElementSibling;

    while (sibling) {
      const candidate = cleanValue(sibling.textContent || "", exclusionPattern).trim();

      if (candidate) {
        return candidate;
      }

      sibling = sibling.previousElementSibling;
    }

    const parent = scope?.parentElement;

    if (parent) {
      const fromParent = cleanValue(removeOptionText(parent.textContent || "", options), exclusionPattern).trim();

      if (fromParent) {
        return fromParent;
      }
    }

    let ancestor = parent?.parentElement;

    while (ancestor) {
      const candidate = cleanValue(removeOptionText(ancestor.textContent || "", options), exclusionPattern).trim();

      if (candidate) {
        return candidate;
      }

      ancestor = ancestor.parentElement;
    }

    return "";
  }

  function getRadioGroups(root) {
    const radios = Array.from(root.querySelectorAll('input[type="radio"]'));

    if (radios.length < 2) {
      return [];
    }

    const groups = new Map();

    for (const radio of radios) {
      const name = radio.getAttribute("name") || "__unnamed__";

      if (!groups.has(name)) {
        groups.set(name, []);
      }

      groups.get(name).push(radio);
    }

    return Array.from(groups.values());
  }

  function stripQuestionNoise(text) {
    return text
      .replace(/\bQuestion\s*\d+\b/gi, " ")
      .replace(/\b\d+\s*\/\s*\d+\s*points?\b/gi, " ")
      .replace(/\b\d+\s*points?\b/gi, " ");
  }

  function isPlaceholderOption(option, index) {
    const label = (option.textContent || "").trim();

    if (option.disabled || !label) {
      return true;
    }

    return index === 0 && (!option.value || /^(choose|select|pick|выбер|--)/i.test(label));
  }

  function extractStructuredQuestion(group, exclusionPattern) {
    const legendId = group.getAttribute("aria-labelledby");
    const legend = legendId ? document.getElementById(legendId) : null;

    const radios = Array.from(group.querySelectorAll('input[type="radio"]'));
    const checkboxes = Array.from(group.querySelectorAll('input[type="checkbox"]'));
    const texts = Array.from(group.querySelectorAll('input[type="text"]'));
    const textareas = Array.from(group.querySelectorAll("textarea"));
    const selects = Array.from(group.querySelectorAll("select"));

    let type;
    let options = [];
    let optionImages = [];

    if (radios.length) {
      type = "radio";
      options = radios.map((radio) => getOptionLabel(radio, exclusionPattern));
      optionImages = radios.map((radio) => getOptionImage(radio));
    } else if (checkboxes.length) {
      type = "checkbox";
      options = checkboxes.map((checkbox) => getOptionLabel(checkbox, exclusionPattern));
      optionImages = checkboxes.map((checkbox) => getOptionImage(checkbox));
    } else if (selects.length) {
      type = "select";
      options = Array.from(selects[0].options)
        .map((option, index) => ({ option, index }))
        .filter(({ option, index }) => !isPlaceholderOption(option, index))
        .map(({ option }) => cleanValue(option.textContent || "", exclusionPattern).trim())
        .filter(Boolean);
    } else if (texts.length || textareas.length) {
      type = "text";
    } else {
      return null;
    }

    if (type !== "text" && !options.length) {
      return null;
    }

    const images = Array.from(group.querySelectorAll("img"))
      .map((img) => img.getAttribute("src") || "")
      .filter(Boolean);

    const links = Array.from(group.querySelectorAll('a[href]'))
      .map((link) => link.href)
      .filter((href) => href && /^https?:/i.test(href))
      .filter((href) => !/coursera\.org/i.test(href));

    let question = "";

    if (legend) {
      question = cleanValue(mathAwareText(legend), exclusionPattern).trim();
    }

    if (!question) {
      question = cleanValue(group.textContent || "", exclusionPattern);
      question = removeOptionText(question, options);
      question = cleanValue(question, exclusionPattern).trim();
    }

    question = stripQuestionNoise(question).trim();

    let feedback = "";
    const fullText = group.textContent || "";

    if (fullText) {
      let remainder = cleanValue(fullText, exclusionPattern);
      remainder = stripQuestionNoise(remainder);

      if (question) {
        remainder = remainder.split(question).join(" ");
      }

      remainder = removeOptionText(remainder, options);

      feedback = cleanValue(remainder, exclusionPattern)
        .replace(/\b\d+\s*points?\b/gi, " ")
        .replace(/^I understand\s*/i, "")
        .trim();
    }

    return { type, question, options, optionImages, images, links, feedback, inputs: { radios, checkboxes, texts, textareas, selects } };
  }

  function getQuestionData(root, exclusionPattern) {
    const structured = Array.from(root.querySelectorAll('[role="group"][aria-labelledby$="-legend"]'));
    const items = [];

    for (const group of structured) {
      const item = extractStructuredQuestion(group, exclusionPattern);

      if (item) {
        items.push(item);
      }
    }

    if (items.length >= 1) {
      return items;
    }

    const legacyItems = [];

    for (const radios of getRadioGroups(root)) {
      const options = radios.map((radio) => getOptionLabel(radio, exclusionPattern)).filter(Boolean);

      if (!options.length) {
        continue;
      }

      const question = extractQuestionText(radios, options, exclusionPattern);
      legacyItems.push({ type: "radio", question, options, optionImages: [], images: [], links: [], feedback: "", inputs: { radios, checkboxes: [], texts: [], textareas: [], selects: [] } });
    }

    return legacyItems.length >= 2 ? legacyItems : [];
  }

  function extractQuizItems(root, exclusionPattern) {
    const items = getQuestionData(root, exclusionPattern);
    return items.length >= 1 ? items : null;
  }

  function formatQuizItems(items, imageIndex) {
    const typeLabel = {
      radio: "ОДИН ВАРИАНТ",
      checkbox: "ВЫБЕРИ ВСЕ ВЕРНЫЕ",
      select: "ОДИН ВАРИАНТ (выпадающий)",
      text: "ВПИШИ ОТВЕТ"
    };

    return items
      .map((item, index) => {
        const lines = [];
        const hint = typeLabel[item.type] || "";
        const imageHint = item.images && item.images.length
          ? " " + item.images.map((url) => `[ИЗОБРАЖЕНИЕ ${imageIndex ? imageIndex.get(url) : "?"}]`).join(" ")
          : "";
        lines.push(`${index + 1}. [${hint}] ${item.question}${imageHint}`);

        for (let i = 0; i < item.options.length; i++) {
          const optionImage = item.optionImages && item.optionImages[i]
            ? imageIndex ? imageIndex.get(item.optionImages[i]) : null
            : null;
          const text = item.options[i] || "";
          const marker = optionImage ? `[ИЗОБРАЖЕНИЕ ${optionImage}]` : "";
          const optionLine = [text, marker].filter(Boolean).join(" ");

          if (optionLine) {
            lines.push(`  - (${i + 1}) ${optionLine}`);
          }
        }

        if (item.feedback) {
          lines.push(`  Обратная связь: ${item.feedback}`);
        }

        return lines.filter(Boolean).join("\n");
      })
      .join("\n\n");
  }

  function selectRadio(radio) {
    const label = (radio.labels && radio.labels.length ? radio.labels[0] : null) || radio.closest("label");

    radio.checked = true;
    radio.dispatchEvent(new Event("input", { bubbles: true }));
    radio.dispatchEvent(new Event("change", { bubbles: true }));

    if (label) {
      label.click();
    } else if (typeof radio.click === "function") {
      radio.click();
    }
  }

  function setChecked(input, checked) {
    if (input.checked === checked) {
      return;
    }

    if (typeof input.click === "function") {
      input.click();
    } else {
      input.checked = checked;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function setText(input, value) {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

    if (setter) {
      setter.call(input, value);
    } else {
      input.value = value;
    }

    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function decodeEntities(value) {
    return String(value == null ? "" : value)
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;/gi, "'")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
  }

  function normalizeOption(value) {
    return decodeEntities(value)
      .toLowerCase()
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2013\u2014]/g, "-")
      .replace(/\s+/g, " ")
      .replace(/[.,;:!?"'`()\[\]{}]/g, "")
      .replace(/^\s*(?:option|вариант)\s+/i, "")
      .trim();
  }

  function tokenScore(option, target) {
    const left = option.split(" ").filter((word) => word.length > 1);
    const right = target.split(" ").filter((word) => word.length > 1);

    if (left.length < 2 || right.length < 2) {
      return 0;
    }

    const leftSet = new Set(left);
    const rightSet = new Set(right);
    let common = 0;

    for (const word of rightSet) {
      if (leftSet.has(word)) {
        common++;
      }
    }

    const union = new Set([...leftSet, ...rightSet]).size;

    return union ? common / union : 0;
  }

  function matchOptionIndex(options, answer) {
    const target = normalizeOption(answer);

    if (!target) {
      return -1;
    }

    let best = -1;
    let bestScore = 0;

    for (let i = 0; i < options.length; i++) {
      const option = normalizeOption(options[i]);

      if (!option) {
        continue;
      }

      if (option === target) {
        return i;
      }

      const score = option.includes(target) || target.includes(option)
        ? Math.min(option.length, target.length) / Math.max(option.length, target.length)
        : tokenScore(option, target) * 0.9;

      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }

    return bestScore >= 0.5 ? best : -1;
  }

  function coerceAnswer(value) {
    if (value == null) {
      return "";
    }

    if (Array.isArray(value)) {
      return value.map((entry) => coerceAnswer(entry));
    }

    if (typeof value === "object") {
      const inner =
        value.answer ?? value.text ?? value.choice ?? value.value ??
        value.option ?? value.options ?? value.index ?? value.i ?? value.label ??
        value.correct_answer ?? value.correct ?? value.selected ?? value.content ?? value.result;

      return inner == null ? "" : coerceAnswer(inner);
    }

    return value;
  }

  function cleanAnswerText(value) {
    return decodeEntities(value)
      .replace(/^\s*(?:answer|ответ|option|вариант)\s*[:\-–]?\s*/i, "")
      .replace(/[*_`]/g, "")
      .replace(/^\s*\(?(\d+)\)?\s*[.):\-–]\s+/, "")
      .replace(/^\s*\(?([A-Za-z])\)?\s*[.):\-–]\s+/, "")
      .replace(/\s*[\[(]\s*(?:\d+|[A-Za-z])\s*[\])]\s*$/, "")
      .trim();
  }

  function indexFromNumber(value, inputCount) {
    const number = Number(value);

    return Number.isInteger(number) && number >= 1 && number <= inputCount ? number - 1 : -1;
  }

  function indexFromLetter(value, inputCount) {
    const match = String(value == null ? "" : value).match(/^\s*\(?([A-Za-z])\)?\s*$/);

    if (!match) {
      return -1;
    }

    const index = match[1].toUpperCase().charCodeAt(0) - 65;

    return index >= 0 && index < inputCount ? index : -1;
  }

  function resolveAnswerIndex(options, answer, inputCount) {
    if (Array.isArray(answer)) {
      const first = answer.find((entry) => String(entry == null ? "" : entry).trim() !== "");
      answer = first == null ? "" : first;
    }

    if (answer == null || typeof answer === "boolean") {
      return -1;
    }

    if (typeof answer === "number") {
      return indexFromNumber(answer, inputCount);
    }

    const text = String(answer).trim();

    if (!text) {
      return -1;
    }

    // "3", "(3)", "3" с точкой на конце.
    const numeric = text.match(/^\(?\s*(\d+)\s*\)?\.?$/);

    if (numeric) {
      const index = indexFromNumber(numeric[1], inputCount);

      if (index >= 0) {
        return index;
      }
    }

    const cleaned = cleanAnswerText(text);

    // Текст варианта: точное совпадение или похожий по словам.
    let index = matchOptionIndex(options, cleaned);

    if (index < 0 && cleaned !== text) {
      index = matchOptionIndex(options, text);
    }

    if (index >= 0) {
      return index;
    }

    // "2. Gas" уже очистился до "Gas"; остался числовой хвост.
    const cleanedNumeric = cleaned.match(/^\(?\s*(\d+)\s*\)?\.?$/);

    if (cleanedNumeric) {
      const numberIndex = indexFromNumber(cleanedNumeric[1], inputCount);

      if (numberIndex >= 0) {
        return numberIndex;
      }
    }

    // "C" / "C)" / "(C)" как буква варианта.
    return indexFromLetter(cleaned, inputCount);
  }

  function applyRadioAnswer(item, answer) {
    const options = item.options || [];
    const index = resolveAnswerIndex(options, answer, item.inputs.radios.length);

    if (index < 0 || index >= item.inputs.radios.length) {
      return false;
    }

    selectRadio(item.inputs.radios[index]);
    return true;
  }

  function applyCheckboxAnswer(item, answer) {
    const list = Array.isArray(answer) ? answer : [answer];
    const options = item.options || [];

    for (const checkbox of item.inputs.checkboxes) {
      setChecked(checkbox, false);
    }

    let selected = 0;

    for (const raw of list) {
      if (raw == null || (typeof raw === "string" && !raw.trim())) {
        continue;
      }

      const index = resolveAnswerIndex(options, raw, item.inputs.checkboxes.length);

      if (index >= 0 && index < item.inputs.checkboxes.length) {
        setChecked(item.inputs.checkboxes[index], true);
        selected++;
        continue;
      }

      if (typeof raw !== "string") {
        continue;
      }

      // "A и C", "A, C", "A and C" одним элементом.
      const parts = raw.split(/[,;|]|\s+(?:and|и)\s+/i).map((part) => part.trim()).filter(Boolean);

      if (parts.length < 2) {
        continue;
      }

      for (const part of parts) {
        const partIndex = resolveAnswerIndex(options, part, item.inputs.checkboxes.length);

        if (partIndex >= 0 && partIndex < item.inputs.checkboxes.length) {
          setChecked(item.inputs.checkboxes[partIndex], true);
          selected++;
        }
      }
    }

    return selected > 0;
  }

  function applyTextAnswer(item, answer) {
    const value = typeof answer === "number" ? String(answer) : answer;

    if (typeof value !== "string" || !value.trim()) {
      return false;
    }

    const inputs = [...(item.inputs.texts || []), ...(item.inputs.textareas || [])];

    if (!inputs.length) {
      return false;
    }

    const parts = value.split(/\s*\|\s*|\n/).map((part) => part.trim()).filter(Boolean);

    if (inputs.length > 1 && parts.length === inputs.length) {
      inputs.forEach((input, index) => setText(input, parts[index]));
      return true;
    }

    setText(inputs[0], value.trim());
    return true;
  }

  function applySelectAnswer(item, answer) {
    const select = item.inputs.selects[0];

    if (!select) {
      return false;
    }

    const options = Array.from(select.options);
    const placeholders = new Set(
      options
        .map((option, index) => {
          const label = (option.textContent || "").trim();

          if (option.disabled) {
            return index;
          }

          return index === 0 && (!option.value || /^(choose|select|pick|выбер|--)/i.test(label)) ? index : -1;
        })
        .filter((index) => index >= 0)
    );
    const real = options
      .map((option, index) => ({ option, index, label: (option.textContent || "").trim() }))
      .filter((entry) => !placeholders.has(entry.index));

    if (!real.length) {
      return false;
    }

    const target = resolveAnswerIndex(real.map((entry) => entry.label), answer, real.length);

    if (target < 0 || target >= real.length) {
      return false;
    }

    select.selectedIndex = real[target].index;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function checkHonorCodeAgreement() {
    const checkbox = document.querySelector('input[type="checkbox"][aria-labelledby*="agreement-checkbox"]');

    if (!checkbox) {
      return false;
    }

    setChecked(checkbox, true);
    return true;
  }

  function questionKey(item) {
    return normalizeOption(stripQuestionNoise(String(item.question || "")));
  }

  // Ответы привязываются к тексту вопроса, а не к позиции: страница между
  // чтением и заполнением может перерисоваться и переставить вопросы.
  function matchAnswerSlots(items, questions, types, answerCount) {
    const sourceQuestions = Array.isArray(questions) ? questions : [];
    const sourceTypes = Array.isArray(types) ? types : [];
    const currentQuestions = items.map((item) => questionKey(item));
    const used = new Set();
    const slots = items.map(() => -1);

    const typeMatches = (sourceIndex, item) =>
      !sourceTypes[sourceIndex] || sourceTypes[sourceIndex] === item.type;

    for (let i = 0; i < items.length; i++) {
      if (!currentQuestions[i]) {
        continue;
      }

      for (let j = 0; j < sourceQuestions.length; j++) {
        if (used.has(j) || !typeMatches(j, items[i])) {
          continue;
        }

        const key = normalizeOption(stripQuestionNoise(String(sourceQuestions[j] || "")));

        if (key === currentQuestions[i]) {
          slots[i] = j;
          used.add(j);
          break;
        }
      }
    }

    for (let i = 0; i < items.length; i++) {
      if (slots[i] >= 0 || !currentQuestions[i]) {
        continue;
      }

      let best = -1;
      let bestScore = 0;

      for (let j = 0; j < sourceQuestions.length; j++) {
        if (used.has(j) || !typeMatches(j, items[i])) {
          continue;
        }

        const key = normalizeOption(stripQuestionNoise(String(sourceQuestions[j] || "")));
        const score = key ? tokenScore(currentQuestions[i], key) : 0;

        if (score > bestScore) {
          bestScore = score;
          best = j;
        }
      }

      if (best >= 0 && bestScore >= 0.6) {
        slots[i] = best;
        used.add(best);
      }
    }

    for (let i = 0; i < items.length; i++) {
      if (slots[i] >= 0 || i >= answerCount || used.has(i)) {
        continue;
      }

      slots[i] = i;
      used.add(i);
    }

    return slots;
  }

  function applyQuizAnswers(answers, questions, types) {
    const items = getQuestionData(document.body, null);

    if (!items.length) {
      throw new Error("На странице не найдены вопросы теста.");
    }

    const normalized = Array.isArray(answers) ? answers.map((entry) => coerceAnswer(entry)) : [];
    const slots = matchAnswerSlots(items, questions, types, normalized.length);
    const applied = [];
    const skipped = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const slot = slots[i] >= 0 ? slots[i] : i;
      const answer = normalized[slot];
      let ok = false;

      if (item.type === "radio") {
        ok = applyRadioAnswer(item, answer);
      } else if (item.type === "checkbox") {
        ok = applyCheckboxAnswer(item, answer);
      } else if (item.type === "select") {
        ok = applySelectAnswer(item, answer);
      } else if (item.type === "text") {
        ok = applyTextAnswer(item, answer);
      }

      if (ok) {
        applied.push(i + 1);
      } else {
        skipped.push(i + 1);
      }
    }

    const honorChecked = checkHonorCodeAgreement();

    return {
      applied,
      skipped,
      total: items.length,
      honorChecked,
      partial: applied.length !== items.length
    };
  }

  function findAnswerEditors() {
    return Array.from(document.querySelectorAll(
      '[contenteditable="true"][role="textbox"], [contenteditable="true"][data-slate-editor="true"]'
    ));
  }

  function detectAssignmentType() {
    if (findAnswerEditors().length) {
      return "richText";
    }

    if (document.querySelectorAll('[role="group"][aria-labelledby$="-legend"]').length) {
      return "quiz";
    }

    if (
      document.querySelectorAll(
        '[data-testid*="rubric"], .rc-SubmissionPartFileUpload, .rc-SubmissionPartEditView, .rc-PeerItemVerificationSubmission, input[type="file"]'
      ).length
    ) {
      return "fileUpload";
    }

    return "unknown";
  }

  function dismissBlockingModals() {
    const dialog = document.querySelector('[role="dialog"]');

    if (!dialog) {
      return { certificate: false, moduleComplete: false, dismissed: false };
    }

    const text = dialog.textContent || "";
    const isCertificate = !!(dialog.querySelector('[data-testid="certificate-container"]')) || /certificate/i.test(text);
    const isModuleComplete =
      !!(dialog.querySelector('[data-testid="item-complete-container"], [data-testid="mark-complete"]')) ||
      /module complete|great work|week complete/i.test(text);

    if (!isCertificate && !isModuleComplete) {
      return { certificate: false, moduleComplete: false, dismissed: false };
    }

    const closeButton = Array.from(dialog.querySelectorAll('button, [role="button"]')).find((element) => {
      const label = `${element.textContent || ""} ${element.getAttribute("aria-label") || ""}`.toLowerCase();
      return /\bclose\b|\bnot now\b|\bskip\b|\bdismiss\b|\bcontinue\b|\bnext\b/.test(label);
    });

    if (closeButton) {
      closeButton.click();
    }

    return { certificate: isCertificate, moduleComplete: isModuleComplete, dismissed: !!closeButton };
  }

  function completePeerReview(feedbackText) {
    const text = feedbackText || "goat";

    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    const groups = new Map();

    for (const radio of radios) {
      const name = radio.getAttribute("name") || "";

      if (!name.startsWith("peer-options-")) {
        continue;
      }

      if (!groups.has(name)) {
        groups.set(name, []);
      }

      groups.get(name).push(radio);
    }

    let rated = 0;

    for (const group of groups.values()) {
      if (group.length) {
        selectRadio(group[0]);
        rated++;
      }
    }

    const textareas = Array.from(document.querySelectorAll(
      '[data-testid="peer-review-multi-line-input-field"] textarea, textarea[aria-label*="Peer Review comments"], textarea[aria-label*="comments"]'
    ));

    let filled = 0;

    for (const textarea of textareas) {
      setText(textarea, text);
      filled++;
    }

    return { rated, filled };
  }

  function clickSubmitReview() {
    const buttons = Array.from(document.querySelectorAll("button"));
    const submit = buttons.find((button) => /submit review/i.test(button.textContent || ""));

    if (!submit) {
      return false;
    }

    submit.click();
    return true;
  }

  function getReviewCount() {
    const element = document.querySelector('[data-testid="review-count"]');

    if (!element) {
      return -1;
    }

    const match = (element.textContent || "").match(/(\d+)\s*left/i);
    return match ? parseInt(match[1], 10) : -1;
  }

  function extractAssignmentText() {
    const editorCount = findAnswerEditors().length;

    const prompt = document.querySelector('[data-testid="cml-viewer"]');

    if (prompt) {
      const text = mathAwareText(prompt);
      const images = Array.from(prompt.querySelectorAll("img"))
        .map((img) => img.getAttribute("src") || "")
        .filter(Boolean);

      return {
        title: document.title,
        url: location.href,
        text: stripBuiltInBoilerplate(text.replace(/\s+/g, " ").trim()),
        editorCount,
        images
      };
    }

    const clone = document.body.cloneNode(true);

    clone.querySelectorAll(
      'script, style, noscript, template, nav, header, footer, button, svg, iframe, [aria-hidden="true"], [contenteditable], [role="toolbar"], .rc-CMLEditor'
    ).forEach((element) => element.remove());

    const text = clone.textContent || "";
    const images = Array.from(document.body.querySelectorAll("img"))
      .map((img) => img.getAttribute("src") || "")
      .filter((src) => src && /^https?:/i.test(src));

    return {
      title: document.title,
      url: location.href,
      text: stripBuiltInBoilerplate(text.replace(/\s+/g, " ").trim()),
      editorCount,
      images
    };
  }

  function extractFullText() {
    const clone = document.body.cloneNode(true);

    clone.querySelectorAll(
      'script, style, noscript, template, nav, header, footer, button, svg, iframe, [aria-hidden="true"], [contenteditable], [role="toolbar"], .rc-CMLEditor'
    ).forEach((element) => element.remove());

    const text = clone.textContent || "";

    return {
      title: document.title,
      url: location.href,
      text: stripBuiltInBoilerplate(text.replace(/\s+/g, " ").trim())
    };
  }

  function insertIntoEditor(editor, text) {
    editor.focus();

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);

    document.execCommand("insertText", false, text);
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }

  function fillAnswerEditors(texts) {
    const editors = findAnswerEditors();

    if (!editors.length) {
      return { filled: 0, total: 0 };
    }

    const count = Math.min(editors.length, texts.length);

    for (let i = 0; i < count; i++) {
      insertIntoEditor(editors[i], texts[i]);
    }

    return { filled: count, total: editors.length };
  }

  function normalizeResultText(value) {
    return String(value || "")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseQuizResult({ status, grade, threshold, text } = {}) {
    const normalized = normalizeResultText(text).toLowerCase();
    const normalizedStatus = String(status || "").toLowerCase();
    const numericGrade = Number.isFinite(grade) ? grade : null;
    const numericThreshold = Number.isFinite(threshold) ? threshold : null;

    const explicitFail = /didn't pass|did not pass|not passed|не сдано|не пройдено/i.test(normalized);
    const explicitPass = /you passed|passed!|congratulations|сдано|пройдено/i.test(normalized);

    let passed = false;
    let failed = false;

    if (normalizedStatus === "pass" || normalizedStatus === "passed") {
      passed = true;
    } else if (normalizedStatus === "fail" || normalizedStatus === "failed") {
      failed = true;
    } else if (numericGrade !== null && numericThreshold !== null) {
      if (numericGrade >= numericThreshold) {
        passed = true;
      } else {
        failed = true;
      }
    } else if (explicitFail) {
      failed = true;
    } else if (explicitPass) {
      passed = true;
    }

    return {
      passed,
      failed,
      grade: numericGrade,
      threshold: numericThreshold,
      status: normalizedStatus || null
    };
  }

  function getQuizResult() {
    const banner = document.querySelector('[data-testid="result-banner"]');
    const scope = banner || document.querySelector('[data-testid="assignment-cover-redesign"]') || document.body;
    const text = scope ? scope.textContent || "" : "";
    const status = banner ? banner.getAttribute("data-result-status") || "" : "";
    const gradeNode = banner ? banner.querySelector('[data-testid="grade"]') : null;
    const gradeMatch = (gradeNode?.textContent || "").match(/([\d.]+)\s*%/);
    const fallbackGrade = text.match(/your grade:\s*([\d.]+)\s*%/i);
    const lastPercent = banner ? Array.from(text.matchAll(/([\d.]+)\s*%/g)).at(-1) : null;
    const grade = gradeMatch
      ? parseFloat(gradeMatch[1])
      : fallbackGrade
        ? parseFloat(fallbackGrade[1])
        : lastPercent
          ? parseFloat(lastPercent[1])
          : null;
    const thresholdMatch = text.match(/(?:at least|не менее)\s*([\d.]+)\s*%/i);
    const threshold = thresholdMatch ? parseFloat(thresholdMatch[1]) : null;

    return {
      ...parseQuizResult({ status, grade, threshold, text }),
      signature: banner ? `${status}|${normalizeResultText(banner.textContent)}` : "",
      hasSubmitControls: !!document.querySelector('[data-e2e="AttemptSubmitControls"]')
    };
  }

  function getQuestionStatuses() {
    const groups = Array.from(document.querySelectorAll('[role="group"][aria-labelledby$="-legend"]'));

    return groups.map((group) => {
      let text = (group.textContent || "").toLowerCase();
      const next = group.nextElementSibling;

      if (next) {
        text += " " + (next.textContent || "").toLowerCase();
      }

      const parent = group.parentElement;

      if (parent && parent.querySelectorAll('[role="group"][aria-labelledby$="-legend"]').length === 1) {
        const feedback = Array.from(parent.querySelectorAll(
          '[class*="feedback" i], [data-testid*="feedback" i], [class*="result" i], [class*="Result" i]'
        ));

        for (const element of feedback) {
          text += " " + (element.textContent || "").toLowerCase();
        }
      }

      if (/try again|good effort|incorrect|not quite|you missed|неверно|неправильно/.test(text)) {
        return "wrong";
      }

      if (/nice work|correct answer|you got it|\bcorrect\b|верно|правильно/.test(text)) {
        return "correct";
      }

      return "unknown";
    });
  }

  // Восстанавливает прошлые ответы прямо из открытой страницы с результатами:
  // что было выбрано в radio/checkbox/select и что вписано в поля.
  function getAnsweredQuiz() {
    const groups = Array.from(document.querySelectorAll('[role="group"][aria-labelledby$="-legend"]'));

    return groups.map((group) => {
      const radios = Array.from(group.querySelectorAll('input[type="radio"]'));
      const checkboxes = Array.from(group.querySelectorAll('input[type="checkbox"]'));
      const selects = Array.from(group.querySelectorAll("select"));
      const texts = Array.from(group.querySelectorAll('input[type="text"], input[type="number"]'));
      const textareas = Array.from(group.querySelectorAll("textarea"));

      const legendId = group.getAttribute("aria-labelledby");
      const legend = legendId ? document.getElementById(legendId) : null;
      const question = (legend ? legend.textContent : group.textContent || "").trim();

      if (radios.length) {
        const checked = radios.find((radio) => radio.checked);

        return {
          question,
          text: checked ? getOptionLabel(checked, null) : "",
          index: checked ? radios.indexOf(checked) + 1 : 0
        };
      }

      if (checkboxes.length) {
        const picked = checkboxes
          .map((checkbox, index) => ({ checkbox, index }))
          .filter(({ checkbox }) => checkbox.checked);

        return {
          question,
          text: picked.map(({ checkbox }) => getOptionLabel(checkbox, null)).filter(Boolean),
          index: picked.map(({ index }) => index + 1)
        };
      }

      if (selects.length) {
        const select = selects[0];
        const real = Array.from(select.options)
          .map((option, index) => ({ option, index }))
          .filter(({ option, index }) => !isPlaceholderOption(option, index));
        const chosen = real.findIndex(({ option }) => option.selected);

        return {
          question,
          text: chosen >= 0 ? (real[chosen].option.textContent || "").trim() : "",
          index: chosen + 1
        };
      }

      const input = texts[0] || textareas[0];
      const value = input ? (input.value || "").trim() : "";

      return { question, text: value, index: value };
    });
  }

  function extractAssignmentLinks() {
    const include = /practice assignment|graded assignment|ungraded assignment|self-check/i;
    const exclude = /reading|video|peer|discussion|completed|passed|locked|complete previous item to unlock|grade:\s*100/i;
    const seen = new Set();
    const results = [];

    for (const anchor of document.querySelectorAll('a[href]')) {
      const label = `${anchor.textContent || ""} ${anchor.getAttribute("aria-label") || ""}`.trim();

      if (!include.test(label) || exclude.test(label)) {
        continue;
      }

      const href = anchor.href;

      if (!href || !/^https?:/i.test(href) || seen.has(href)) {
        continue;
      }

      seen.add(href);
      results.push({ url: href, label: label.slice(0, 80) });
    }

    return results;
  }

  function createExclusionPattern(phrase) {
    const normalizedPhrase = phrase.trim();

    if (!normalizedPhrase) {
      return null;
    }

    const escapedPhrase = normalizedPhrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escapedPhrase, "gi");
  }

  function escapeHtml(value) {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;");
  }

  function cleanValue(value, exclusionPattern) {
    const withoutBoilerplate = stripBuiltInBoilerplate(value);
    const withoutExcludedPhrase = exclusionPattern
      ? withoutBoilerplate.replace(exclusionPattern, "")
      : withoutBoilerplate;
    return withoutExcludedPhrase.replace(/\s+/g, " ");
  }

  function cleanUrl(value) {
    try {
      const url = new URL(value, document.baseURI);
      return `${url.origin}${url.pathname}`;
    } catch {
      return value;
    }
  }

  function getSafeAttributes(element, exclusionPattern) {
    const attributes = [];

    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase();

      if (!PRESERVED_ATTRIBUTES.has(name)) {
        continue;
      }

      let value = cleanValue(attribute.value, exclusionPattern).trim();

      if (name === "href" || name === "src") {
        value = cleanUrl(value);
      }

      if (value) {
        attributes.push(`${name}="${escapeHtml(value)}"`);
      }
    }

    return attributes.length ? ` ${attributes.join(" ")}` : "";
  }

  function createWriter(characterLimit) {
    return {
      parts: [],
      size: 0,
      characterLimit,
      wasTruncated: false,
      append(value) {
        if (this.wasTruncated || !value) {
          return false;
        }

        if (this.size + value.length > this.characterLimit) {
          this.wasTruncated = true;
          return false;
        }

        this.parts.push(value);
        this.size += value.length;
        return true;
      },
      rewind(mark) {
        while (this.parts.length > mark) {
          this.size -= this.parts.pop().length;
        }
      }
    };
  }

  function shouldSkipElement(element) {
    return (
      REMOVABLE_ELEMENTS.has(element.tagName.toLowerCase()) ||
      element.hidden ||
      element.getAttribute("aria-hidden") === "true"
    );
  }

  function serializeNode(node, exclusionPattern, writer) {
    if (writer.wasTruncated || node.nodeType === Node.COMMENT_NODE) {
      return false;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      const text = cleanValue(node.nodeValue || "", exclusionPattern);
      return text.trim() ? writer.append(escapeHtml(text)) : false;
    }

    if (node.nodeType !== Node.ELEMENT_NODE || shouldSkipElement(node)) {
      return false;
    }

    const tagName = node.tagName.toLowerCase();
    const mark = writer.parts.length;
    const openingTag = `<${tagName}${getSafeAttributes(node, exclusionPattern)}>`;

    if (!writer.append(openingTag)) {
      return false;
    }

    if (VOID_ELEMENTS.has(tagName)) {
      return true;
    }

    let hasContent = false;

    for (const child of node.childNodes) {
      hasContent = serializeNode(child, exclusionPattern, writer) || hasContent;

      if (writer.wasTruncated) {
        return hasContent;
      }
    }

    if (!hasContent && EMPTY_ELEMENTS_TO_DROP.has(tagName)) {
      writer.rewind(mark);
      return false;
    }

    writer.append(`</${tagName}>`);
    return true;
  }

  function clickMySubmission() {
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    const target = candidates.find((element) => {
      const label = `${element.textContent || ""} ${element.getAttribute("aria-label") || ""}`.toLowerCase();
      return /\bmy submission\b/.test(label);
    });

    if (!target) {
      return false;
    }

    target.click();
    return true;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function visibleButtons() {
    return Array.from(document.querySelectorAll('button, a, [role="button"]'))
      .filter((element) => isElementVisible(element));
  }

  function findVisibleButton(pattern) {
    return visibleButtons().find((element) => {
      const label = `${element.textContent || ""} ${element.getAttribute("aria-label") || ""}`;
      return pattern.test(label);
    });
  }

  async function enterCourse() {
    const steps = [];
    const remember = (element, label) => {
      const text = `${element.textContent || element.getAttribute("aria-label") || ""}`.trim() || label;
      element.click();
      steps.push(text);
    };

    const direct = findVisibleButton(/\b(go to course|get started|resume course|resume|continue course|start course|audit the course)\b/i);

    if (direct) {
      remember(direct, "entry");

      if (/audit/i.test(direct.textContent || "")) {
        await wait(800);
        const continueButton = document.querySelector('button[data-track-component="course_enroll_modal_continue_button"]');

        if (continueButton && continueButton.offsetParent !== null) {
          remember(continueButton, "continue");
          await wait(1500);
        }
      } else {
        await wait(1500);
      }

      const next = findVisibleButton(/\b(get started|resume course|resume|go to course|start course|continue)\b/i);

      if (next && next !== direct) {
        remember(next, "next");
        await wait(1200);
      }

      return { clicked: true, label: steps.join(" → "), confirmed: true };
    }

    const enroll = findVisibleButton(/\b(join for free|enroll)\b/i);

    if (!enroll) {
      return { clicked: false, label: "" };
    }

    remember(enroll, "enroll");
    await wait(900);

    const auditRadio = document.querySelector("#choice-input-AUDIT_COURSE");

    if (auditRadio) {
      setChecked(auditRadio, true);
      steps.push("Audit the course");
    } else {
      const audit = findVisibleButton(/\b(audit the course|full course|audit)\b/i);

      if (audit) {
        remember(audit, "audit");
      }
    }

    await wait(300);

    let continueButton = document.querySelector('button[data-track-component="course_enroll_modal_continue_button"]');

    if (!continueButton || continueButton.offsetParent === null) {
      continueButton = findVisibleButton(/\bcontinue\b/i);
    }

    if (continueButton && continueButton.offsetParent !== null) {
      remember(continueButton, "continue");
      await wait(1800);
    }

    const next = findVisibleButton(/\b(get started|resume course|resume|go to course|start course|continue)\b/i);

    if (next) {
      remember(next, "next");
      await wait(1200);
    }

    return { clicked: true, label: steps.join(" → "), confirmed: !!next };
  }

  function isElementVisible(element) {
    if (!element) {
      return false;
    }

    if (element.hidden) {
      return false;
    }

    if (typeof element.getAttribute === "function" && element.getAttribute("aria-hidden") === "true") {
      return false;
    }

    // Обычный случай: элемент в потоке.
    if (element.offsetParent != null) {
      return true;
    }

    // offsetParent === null бывает и у display:none, и у кнопок внутри fixed/portal-модалок.
    // Пробуем определить по реальной раскладке (getClientRects есть только в настоящем DOM).
    try {
      if (typeof element.getClientRects === "function" && element.getClientRects().length > 0) {
        const view = element.ownerDocument && element.ownerDocument.defaultView;
        const style = view && view.getComputedStyle(element);

        if (style && (style.visibility === "hidden" || style.display === "none")) {
          return false;
        }

        return true;
      }
    } catch {
      // Если раскладку не посчитать — считаем скрытым.
    }

    return false;
  }

  function clickRetryButton() {
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));

    // Модалка "Start attempt" (Continue) — встречается при старте попытки и ретрае.
    const startAttempt = candidates.find(
      (element) =>
        element.getAttribute("data-testid") === "StartAttemptModal__primary-button" && isElementVisible(element)
    );

    if (startAttempt) {
      startAttempt.click();
      return { clicked: true, label: (startAttempt.textContent || "").trim() };
    }

    const coverButton = candidates.find((element) => {
      const text = (element.textContent || "").toLowerCase();
      return (
        element.getAttribute("data-testid") === "CoverPageActionButton" &&
        isElementVisible(element) &&
        /resume|retry|try again|start/i.test(text)
      );
    });

    if (coverButton) {
      coverButton.click();
      return { clicked: true, label: (coverButton.textContent || "").trim() };
    }

    const retry = candidates.find((element) => {
      const text = (element.textContent || "").toLowerCase();
      return (
        isElementVisible(element) &&
        (
          text.includes("resume assignment") ||
          text.includes("retake") ||
          text.includes("try again") ||
          text.includes("retry") ||
          text.includes("start assignment") ||
          text.includes("start quiz")
        )
      );
    });

    if (retry) {
      retry.click();
      return { clicked: true, label: (retry.textContent || "").trim() };
    }

    const continueButton = candidates.find((element) => {
      const label = `${element.textContent || ""} ${element.getAttribute("aria-label") || ""}`.toLowerCase();
      return /\bcontinue\b/.test(label) && isElementVisible(element);
    });

    if (continueButton) {
      continueButton.click();
      return { clicked: true, label: (continueButton.textContent || "").trim() };
    }

    return { clicked: false, label: "" };
  }

  function findSubmitButtons() {
    return Array.from(document.querySelectorAll("button")).filter((button) => {
      const label = `${button.textContent || ""} ${button.getAttribute("aria-label") || ""}`.toLowerCase();
      return isElementVisible(button) && label.includes("submit");
    });
  }

  function submitQuiz() {
    const buttons = findSubmitButtons();

    if (!buttons.length) {
      return Promise.resolve({ submitted: false, confirmed: false });
    }

    const first = buttons[0];
    first.click();

    return new Promise((resolve) => {
      setTimeout(() => {
        const after = findSubmitButtons();
        const confirm = after.find((button) => button !== first && isElementVisible(button));

        if (confirm) {
          confirm.click();
          setTimeout(() => resolve({ submitted: true, confirmed: true }), 250);
        } else {
          resolve({ submitted: true, confirmed: false });
        }
      }, 350);
    });
  }

  function diagnoseDocument() {
    const text = (document.body?.textContent || "").toLowerCase();

    if (text.includes("something went wrong")) {
      return "error";
    }

    if (document.querySelector('[data-testid="playerContainer"], video, [data-testid="video-item-title-and-attribution"]')) {
      return "video";
    }

    if (document.querySelector('[role="group"][aria-labelledby$="-legend"]')) {
      return "quiz";
    }

    if (document.querySelector('[data-testid="cml-viewer"]')) {
      return "assignment";
    }

    return "unknown";
  }

  function cleanCurrentPage(exclusionPhrase, characterLimit = 60000) {
    if (!document.body) {
      throw new Error("На странице нет доступного тега body.");
    }

    const exclusionPattern = createExclusionPattern(exclusionPhrase || "");
    const quizItems = extractQuizItems(document.body, exclusionPattern);
    const resultBanner = document.querySelector('[data-testid="result-banner"]');
    const hasSubmitControls = !!document.querySelector('[data-e2e="AttemptSubmitControls"]');
    const isReview = /\/view-feedback(?:\/|$)/.test(location.pathname) || (!!resultBanner && !hasSubmitControls);

    if (quizItems) {
      const imageIndex = new Map();
      const images = [];
      const links = [];
      const seenLinks = new Set();

      for (const item of quizItems) {
        for (const url of item.images) {
          if (!imageIndex.has(url)) {
            imageIndex.set(url, String(images.length + 1));
            images.push(url);
          }
        }

        for (const url of item.optionImages || []) {
          if (url && !imageIndex.has(url)) {
            imageIndex.set(url, String(images.length + 1));
            images.push(url);
          }
        }

        for (const url of item.links || []) {
          if (!seenLinks.has(url)) {
            seenLinks.add(url);
            links.push(url);
          }
        }
      }

      return {
        title: document.title,
        url: location.href,
        html: formatQuizItems(quizItems, imageIndex),
        wasTruncated: false,
        quizItemCount: quizItems.length,
        quizTypes: quizItems.map((item) => item.type),
        quizQuestions: quizItems.map((item) => item.question || ""),
        quizOptions: quizItems.map((item) => item.options || []),
        isReview,
        pageKind: isReview ? "review" : "quiz",
        images,
        links: links.slice(0, 6)
      };
    }

    const writer = createWriter(characterLimit);

    serializeNode(document.body, exclusionPattern, writer);

    return {
      title: document.title,
      url: location.href,
      html: dropEmptyTags(stripBuiltInBoilerplate(writer.parts.join(""))),
      wasTruncated: writer.wasTruncated,
      quizItemCount: 0,
      quizTypes: [],
      quizQuestions: [],
      quizOptions: [],
      isReview,
      pageKind: diagnoseDocument(),
      images: [],
      links: []
    };
  }

  const api = {
    cleanCurrentPage,
    applyQuizAnswers,
    clickRetryButton,
    enterCourse,
    submitQuiz,
    extractAssignmentText,
    fillAnswerEditors,
    extractAssignmentLinks,
    getQuizResult,
    diagnoseDocument,
    parseQuizResult,
    getQuestionStatuses,
    getAnsweredQuiz,
    extractFullText,
    clickMySubmission,
    detectAssignmentType,
    dismissBlockingModals,
    completePeerReview,
    clickSubmitReview,
    getReviewCount,
    createExclusionPattern,
    stripBuiltInBoilerplate,
    formatQuizItems
  };
  global.PageCleaner = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
