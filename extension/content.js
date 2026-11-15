(() => {
  "use strict";

  if (globalThis.courseAssistantLoaded) return;
  globalThis.courseAssistantLoaded = true;
  const { playbackDefaults, rates, parseAnswer, questionIsValid, assessmentMode, platform,
    questionImageUrl } = CourseAssistant;
  if (!platform(location.href) &&
      !(location.protocol === "about:" && platform(location.ancestorOrigins?.[0]))) return;
  const namedQuestionSelector =
    "[data-question], .j-question, .u-question, .u-questionItem, .question-item";
  const questionSelector = "fieldset, " + namedQuestionSelector;
  const titleSelector = "legend, [data-question-text], .j-title, .question-title, .stem";
  const roleSelector = "[role=radio], [role=checkbox]";
  const controlSelector = "input[type=radio], input[type=checkbox], input[type=text], input:not([type]), textarea, " + roleSelector;
  const optionSelector = "label, li, [role=radio], [role=checkbox], .option";
  const nextEpisodeLabel = /^(?:下一集|下一视频|下一个视频|下一课件|下一个课件|下一小节|下一节|下一课|下一章|下一讲)\s*[›»>→]?$/;
  const unsupportedMediaSelector = "picture, svg, canvas, math, audio, video, iframe, .MathJax, .katex";
  const unsupportedText = /^(?:简答|问答|论述|编程|连线|排序|材料分析|计算题|听力|作文)/;
  let playback = { ...playbackDefaults };
  let pendingScan;
  let solveJob;
  let selected;
  let ready = false;
  let roots = [];
  let timer;
  let videoSequence = 0;
  let catalog = [];
  const videos = new Map();
  const videoData = new WeakMap();
  let attempts = new WeakMap();

  function visible(element) {
    return Boolean(element?.isConnected && element.checkVisibility({
      checkVisibilityCSS: true,
      checkOpacity: true
    }));
  }

  function clean(text) {
    return (text ?? "").replace(/[\u200b\ufeff]/g, "").replace(/\s+/g, " ").trim();
  }

  function readable(element) {
    return clean(element?.innerText ?? element?.textContent);
  }

  function all(selector) {
    return roots.flatMap(root => Array.from(root.querySelectorAll(selector)));
  }

  function observeRoots() {
    const found = [document];
    for (const root of found) {
      for (const element of root.querySelectorAll("*")) {
        const shadow = element.shadowRoot ?? (element instanceof HTMLElement
          ? chrome.dom?.openOrClosedShadowRoot?.(element) : null);
        if (shadow) found.push(shadow);
      }
    }
    if (found.length !== roots.length || found.some((root, index) => root !== roots[index])) {
      observer.disconnect();
      for (const root of found) observer.observe(root, { childList: true, subtree: true, attributes: true,
        attributeFilter: ["class", "style", "hidden", "src", "aria-hidden"] });
      roots = found;
    }
  }

  function mode() {
    const headings = all("h1, main h2").filter(visible).map(readable).join(" ");
    const timers = all("[role=timer]").filter(visible).map(readable).join(" ");
    const examControl = all("button, input[type=submit]").some(control => visible(control) &&
      /^(?:交卷|提交试卷|确认交卷)$/.test(control.value || readable(control)));
    return assessmentMode(location.href, document.title + " " + headings,
      examControl || all("[data-exam-countdown]").some(visible) ? "考试倒计时" : timers);
  }

  function kindOf(control) {
    const role = control.getAttribute("role");
    if (control.type === "radio" || role === "radio") return "single";
    if (control.type === "checkbox" || role === "checkbox") return "multiple";
    return "text";
  }

  function questionText(element, images) {
    const pictures = Array.from(element?.querySelectorAll("img") ?? []);
    if (!pictures.length) return readable(element);
    const urls = pictures.map(picture => {
      const active = picture.currentSrc || (picture.getAttribute("src")?.trim() ? picture.src : "");
      // A lazy-loaded formula can still have a placeholder as its active source.
      if (active && !active.startsWith("data:")) return questionImageUrl(active);
      const lazy = picture.getAttribute("data-src") || picture.getAttribute("data-original");
      if (!lazy) return null;
      try {
        return questionImageUrl(new URL(lazy, picture.baseURI).href);
      } catch {
        return null;
      }
    });
    if (urls.includes(null)) return "";
    const copy = element.cloneNode(true);
    for (const [index, picture] of Array.from(copy.querySelectorAll("img")).entries()) {
      picture.replaceWith(document.createTextNode(" [图" + (images.length + index + 1) + "] "));
    }
    images.push(...urls);
    return clean(copy.textContent);
  }

  function optionParts(input, container) {
    const parts = Array.from(input.labels ?? []);
    const root = input.getRootNode();
    for (const id of (input.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)) {
      parts.push(root.getElementById(id));
    }
    parts.push(input.closest(optionSelector));
    return parts.filter(element => element !== container &&
      visible(element) && container.contains(element) &&
      Array.from(element.querySelectorAll(controlSelector)).every(control => control === input));
  }

  function optionText(input, parts, images) {
    const imagePart = [input, ...parts].find(element => element.querySelector("img"));
    if (imagePart) return questionText(imagePart, images);
    return clean(input.getAttribute("aria-label")) ||
      (input.matches(roleSelector) && readable(input)) ||
      parts.map(part => clean(part.getAttribute("aria-label"))).find(Boolean) ||
      parts.map(readable).find(Boolean) || "";
  }

  function questionOf(container) {
    if (!visible(container)) return null;
    const own = element => element.closest(questionSelector) === container;
    const findTitle = selector => Array.from(container.querySelectorAll(selector)).find(element =>
      own(element) && visible(element) && !element.closest("label, " + roleSelector));
    const title = findTitle(titleSelector) ?? findTitle("h2, h3, h4");
    const images = [];
    const text = questionText(title, images);
    const declared = clean(container.getAttribute("data-question-type") ||
      readable(container.querySelector("[data-question-kind], .question-type")));
    if (!text || unsupportedText.test(declared) || unsupportedText.test(text.replace(/^\d+[.、)\s]*/, "")) ||
        container.querySelector("[contenteditable=true]") || title.querySelector(unsupportedMediaSelector)) return null;

    const controls = [];
    const parts = [];
    for (const element of container.querySelectorAll(controlSelector)) {
      if (!own(element) || element.parentElement.closest(roleSelector)) continue;
      const control = element.matches(roleSelector)
        ? element.querySelector("input[type=radio], input[type=checkbox]") ?? element
        : element;
      if (!own(control)) return null;
      const option = optionParts(control, container);
      if (!visible(control) && !option.length) {
        if (control.closest("[hidden], [aria-hidden=true], [inert]")) continue;
        return null;
      }
      controls.push(control);
      parts.push(option);
    }
    if (!controls.length || controls.some((control, index) =>
      control.matches(":disabled, [readonly], [aria-disabled=true]") ||
      control.closest("[aria-disabled=true]") ||
      control.querySelector(unsupportedMediaSelector) ||
      parts[index].some(part => part.querySelector(unsupportedMediaSelector)))) return null;

    const [first] = controls;
    const kind = kindOf(first);
    if (controls.some(control => kindOf(control) !== kind)) return null;
    if (kind === "single" && controls.some(control => control.type === "radio") &&
        (!first.name || controls.some(control =>
          control.type !== "radio" || control.name !== first.name || control.form !== first.form))) return null;
    if (kind === "text" && !/填空|^fill[-_ ]?blank$/i.test(declared) &&
        !/填空/.test(text.slice(0, 30)) && !/_{2,}|＿{2,}/.test(text)) return null;

    const question = { kind, text, options: kind === "text" ? [] :
      controls.map((input, index) => optionText(input, parts[index], images)) };
    if (images.length) question.images = images;
    if (kind === "text") {
      const markers = text.match(/_{2,}|＿{2,}/g);
      if (markers && markers.length !== controls.length) return null;
      question.blanks = controls.length;
    }
    if (!questionIsValid(question) || new Set(question.options).size !== question.options.length) return null;

    const values = controls.map(control => {
      if (kind === "text") return control.value;
      if (control instanceof HTMLInputElement) return control.checked;
      const aria = control.getAttribute("aria-checked");
      return aria === "true" ? true : aria === "false" ? false : null;
    });
    if (values.includes(null)) return null;
    return { container, controls, question, values };
  }

  function scan(assessment) {
    observeRoots();
    pendingScan = undefined;
    const pageMode = mode();
    if (!assessment && pageMode === "unknown") return { mode: pageMode, questions: [] };
    const items = [];
    let unsupported = 0;
    for (const container of all(questionSelector).filter(visible)) {
      if (pageMode === "unknown" && container.matches("fieldset:not([data-question])")) continue;
      const item = questionOf(container);
      if (!item) {
        if (container.matches(namedQuestionSelector) ||
            container.querySelector(controlSelector + ", [contenteditable=true]")) unsupported++;
      } else if (item.values.every(value => value === "" || value === false)) {
        items.push(item);
      }
    }
    const token = crypto.randomUUID();
    pendingScan = { token, items, url: location.href, nextIndex: 0 };
    return { token, unsupported, mode: pageMode, questions: items.map(({ question }) => question) };
  }

  function setText(input, value) {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function fill(item, proposed, url) {
    const answer = parseAnswer(item.question, proposed);
    if (!answer) return { filled: false, reason: "API 未给出答案。" };
    const expected = [...item.values];
    function recheck() {
      if (location.href !== url) return null;
      const current = questionOf(item.container);
      return current && JSON.stringify(current.question) === JSON.stringify(item.question) &&
        current.values.every((value, index) => value === expected[index]) ? current.controls : null;
    }

    const isText = item.question.kind === "text";
    const targets = isText ? answer.map((_, index) => index) : answer.map(index => index - 1);
    const initial = recheck();
    if (!initial) return { filled: false, reason: "题目或已有答案发生变化。" };
    if (isText && initial.some((input, index) => input.maxLength >= 0 && answer[index].length > input.maxLength)) {
      return { filled: false, reason: "答案超出输入框长度限制。" };
    }
    for (const index of targets) {
      const control = recheck()?.[index];
      if (!control) return { filled: false, reason: "网页未保留填写结果。" };
      if (isText) setText(control, answer[index]);
      else {
        const label = Array.from(control.labels ?? []).find(element =>
          item.container.contains(element) && visible(element));
        (visible(control) ? control : label ?? control).click();
      }
      expected[index] = isText ? answer[index] : true;
      await Promise.resolve();
    }
    return recheck() ? { filled: true } : { filled: false, reason: "网页未保留填写结果。" };
  }

  function apply({ token, index, answer }) {
    if (pendingScan?.token !== token || pendingScan.url !== location.href ||
        index !== pendingScan.nextIndex || index >= pendingScan.items.length) return Promise.resolve({ stale: true });
    const item = pendingScan.items[index];
    if (++pendingScan.nextIndex === pendingScan.items.length) pendingScan = undefined;
    return fill(item, answer, location.href);
  }

  async function runSolveJob(job) {
    let filled = 0;
    const failures = [];
    const send = async (action, details) => {
      if (job.url !== location.href) throw new Error("答题页面已切换。");
      const result = await chrome.runtime.sendMessage({ action, url: job.url, ...details });
      if (!result) throw new Error("答题连接中断。");
      if (result.stale) throw new Error("答题页面或题目列表已切换。");
      if (result.error && !result.invalidAnswer) throw new Error(result.error);
      return result;
    };

    async function requestAnswer(question, frame, progress) {
      let waited = 0;
      for (let attempt = 0; ; attempt++) {
        job.message = "正在请求 API（" + progress + "）。";
        const result = await send("jobAnswer", { question, frame });
        if (!Number.isFinite(result.retryAfterMs)) return result;
        const delay = Math.max(result.retryAfterMs, Math.min(30_000, 3000 * 2 ** attempt));
        if (attempt >= 5 || waited + delay > 120_000) {
          throw new Error("API 仍在限流，已暂停于 " + progress + "。");
        }
        waited += delay;
        job.message = "API 并发受限，" + Math.ceil(delay / 1000) + " 秒后自动重试（" + progress + "）。";
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    try {
      const { scans } = await send("jobScan");
      const unsupported = scans.reduce((sum, scan) => sum + (scan.unsupported ?? 0), 0);
      const skipped = unsupported ? " 另有 " + unsupported + " 道题型或控件无法识别。" : "";
      const count = scans.reduce((sum, scan) => sum + scan.questions.length, 0);
      if (!count) {
        job.message = "没有识别到可填写的空白题。" + skipped;
        return;
      }
      let processed = 0;
      for (const { frame, token, questions } of scans) {
        for (const [index, question] of questions.entries()) {
          const number = ++processed;
          const progress = "第 " + number + "/" + count + " 题，已填写 " + filled + " 题";
          const answer = await requestAnswer(question, frame, progress);
          const result = await send("jobApply", { frame, token, index, answer: answer.answers?.[0] ?? null });
          if (result.filled) filled++;
          else failures.push("第 " + number + " 题：" + (answer.error || result.reason));
        }
      }
      job.message = "已填写 " + filled + " 题，识别到 " + count + " 道空白题。" + skipped +
        (failures.length ? " 未填写 " + failures.length + " 题。" + failures.slice(0, 3).join(" ") : "");
    } catch (error) {
      job.message = error.message + " 已填写 " + filled + " 题。";
    } finally {
      job.running = false;
    }
  }

  function applyRate(video) {
    if (!playback.rate) return;
    const data = videoData.get(video);
    data.originalRate ??= video.playbackRate;
    data.originalDefaultRate ??= video.defaultPlaybackRate;
    data.appliedRate = playback.rate;
    if (video.defaultPlaybackRate !== playback.rate) video.defaultPlaybackRate = playback.rate;
    if (video.playbackRate !== playback.rate) video.playbackRate = playback.rate;
  }

  function restoreRate(video) {
    if (!video) return;
    const data = videoData.get(video);
    clearTimeout(data.rateTimer);
    data.rateTimer = undefined;
    if (video.defaultPlaybackRate === data.appliedRate) video.defaultPlaybackRate = data.originalDefaultRate;
    if (video.playbackRate === data.appliedRate) video.playbackRate = data.originalRate;
    data.originalRate = undefined;
    data.originalDefaultRate = undefined;
    data.appliedRate = undefined;
  }

  function play(video) {
    attempts.set(video, video.currentSrc || video.src);
    applyRate(video);
    video.play().catch(() => {});
  }

  function syncSelected() {
    const video = videos.get(selected);
    if (!visible(video)) return;
    if (videoData.get(video).retries < 3) applyRate(video);
    const src = video.currentSrc || video.src;
    if (playback.autoplay && video.paused && !video.ended && video.readyState > 0 && attempts.get(video) !== src) {
      play(video);
    }
  }

  function registerVideo(video) {
    let data = videoData.get(video);
    if (data) return data;
    data = { id: String(++videoSequence), revision: 0, retries: 0 };
    videoData.set(video, data);
    video.addEventListener("loadedmetadata", () => {
      data.retries = 0;
      if (selected === data.id) syncSelected();
      schedule();
    });
    video.addEventListener("play", () => {
      if (selected !== data.id) return;
      data.retries = 0;
      data.applyOnPlaying = true;
      applyRate(video);
    });
    video.addEventListener("playing", () => {
      if (selected !== data.id || !data.applyOnPlaying) return;
      data.applyOnPlaying = false;
      applyRate(video);
    });
    video.addEventListener("ratechange", () => {
      if (selected !== data.id || !playback.rate ||
          (video.playbackRate === playback.rate && video.defaultPlaybackRate === playback.rate) ||
          data.retries >= 3 || data.rateTimer) return;
      data.retries++;
      data.rateTimer = setTimeout(() => {
        data.rateTimer = undefined;
        if (selected === data.id && video.isConnected) applyRate(video);
      }, 600);
    });
    video.addEventListener("ended", event => {
      if (!event.isTrusted || selected !== data.id || !video.ended) return;
      const following = playback.next && catalog.slice(catalog.findIndex(item => item.id === selected) + 1)
        .map(item => videos.get(item.id)).find(candidate => candidate?.paused && !candidate.ended &&
          (candidate.currentSrc || candidate.src || candidate.querySelector("source[src]")));
      if (following) {
        chrome.runtime.sendMessage({ action: "mediaNext", id: videoData.get(following).id, url: location.href }).catch(() => {});
      } else if (playback.nextEpisode) {
        chrome.runtime.sendMessage({ action: "episodeEnded", id: data.id, url: location.href }).catch(() => {});
      }
    });
    return data;
  }

  function refresh() {
    clearTimeout(timer);
    timer = undefined;
    observeRoots();
    const list = all("video");
    const nextCatalog = [];
    videos.clear();
    for (const video of list) {
      if (!visible(video)) continue;
      const rect = video.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const data = registerVideo(video);
      const src = video.currentSrc || video.src || video.srcObject;
      if (src !== data.source) {
        data.source = src;
        data.revision++;
      }
      videos.set(data.id, video);
      nextCatalog.push({ id: data.id, area: Math.round(rect.width * rect.height), revision: data.revision,
        ready: video.readyState > 0,
        label: clean(video.getAttribute("aria-label") || video.title).slice(0, 80) });
    }
    const changed = JSON.stringify(nextCatalog) !== JSON.stringify(catalog);
    catalog = nextCatalog;
    if (changed) chrome.runtime.sendMessage({ action: "mediaChanged" }).catch(() => {});
  }

  function schedule() {
    if (!timer) timer = setTimeout(refresh, 250);
  }

  function moocNextLesson() {
    if (platform(location.href) !== "mooc" || !location.hash.startsWith("#/learn/content?") ||
        !document.querySelector(".videoDetail .mooc-video-player video")) return null;
    const menu = document.querySelector(".u-learnBCUI .j-lesson > .u-select");
    const currentLabel = menu?.querySelector(":scope > .j-up");
    if (!visible(currentLabel)) return null;
    const choices = Array.from(menu.querySelectorAll(":scope > .j-list > .list"));
    const current = clean(currentLabel.textContent);
    if (!current || choices.filter(choice => clean(choice.textContent) === current).length !== 1) return null;
    const next = choices[choices.findIndex(choice => clean(choice.textContent) === current) + 1];
    if (!next || /考试|测验|作业|讨论/.test(clean(next.textContent))) return null;
    if (!visible(next)) currentLabel.click();
    return visible(next) ? next : null;
  }

  function nextEpisodeControl() {
    observeRoots();
    if (!playback.nextEpisode || mode() !== "unknown") return null;
    const candidates = all("a[href], button, [role=button]").filter(control => {
      if (!visible(control) || control.closest('[aria-disabled="true"], [inert]') ||
          control.matches(":disabled, .disabled") ||
          !nextEpisodeLabel.test(clean(control.getAttribute("aria-label") || control.title || readable(control)))) return false;
      if (control instanceof HTMLAnchorElement) {
        return control.origin === location.origin && (!control.target || control.target === "_self") &&
          !control.hasAttribute("download") && assessmentMode(control.href) === "unknown";
      }
      return !(control instanceof HTMLButtonElement && control.form && control.type === "submit");
    });
    if (candidates.length === 1) return candidates[0];
    const href = candidates[0]?.href;
    if (href && candidates.every(control => control.href === href)) return candidates[0];
    return candidates.length === 0 ? moocNextLesson() : null;
  }

  function routeChanged() {
    if (pendingScan?.url !== location.href) pendingScan = undefined;
    if (solveJob?.url !== location.href) solveJob = undefined;
    schedule();
  }

  const observer = new MutationObserver(schedule);
  observeRoots();
  schedule();
  window.addEventListener("hashchange", routeChanged);
  window.addEventListener("popstate", routeChanged);
  window.addEventListener("resize", schedule);

  function restorePlayback(settings) {
    const previous = playback;
    playback = { ...playbackDefaults, ...settings };
    if (!rates.includes(playback.rate)) playback.rate = playbackDefaults.rate;
    if (previous.rate !== playback.rate) {
      for (const video of videos.values()) videoData.get(video).retries = 0;
      if (!playback.rate) restoreRate(videos.get(selected));
    }
    if (previous.autoplay !== playback.autoplay) attempts = new WeakMap();
    ready = true;
    syncSelected();
  }

  chrome.storage.sync.get("playback").then(({ playback: saved }) => {
    if (!ready) restorePlayback(saved);
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.playback) restorePlayback(changes.playback.newValue);
  });

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.tab || !message ||
        !sender.url?.startsWith(chrome.runtime.getURL(""))) return;
    if (["startSolve", "solveStatus"].includes(message.action) && window === window.top) {
      if (message.action === "startSolve" && !solveJob?.running) {
        solveJob = { url: location.href, running: true, message: "正在识别当前页…" };
        void runSolveJob(solveJob);
      }
      respond(solveJob?.url === location.href ? solveJob : {});
    } else if (["mode", "scan", "apply"].includes(message.action)) {
      if (message.action === "mode") {
        observeRoots();
        respond({ mode: mode() });
      }
      if (message.action === "scan") respond(scan(message.assessment === true));
      if (message.action === "apply") {
        apply(message).then(respond, () => respond({ filled: false, reason: "网页控件未能填写。" }));
        return true;
      }
    } else if (message.action === "routeUpdated") {
      routeChanged();
      respond({});
    } else if (message.action === "mediaCatalog") {
      if (timer) refresh();
      respond({ videos: catalog.map(item => ({ ...item, ended: videos.get(item.id)?.ended === true })) });
    } else if (message.action === "mediaSelect") {
      const previous = selected;
      selected = videos.has(message.id) ? message.id : undefined;
      if (previous !== selected) restoreRate(videos.get(previous));
      if (selected && ((message.play && playback.next) || (message.episode && playback.nextEpisode))) {
        const video = videos.get(selected);
        if (video.paused && !video.ended) play(video);
      } else syncSelected();
      respond({});
    } else if (message.action === "nextEpisode") {
      const control = nextEpisodeControl();
      if (!control) {
        respond({ clicked: false });
      } else {
        respond({ clicked: true, href: control instanceof HTMLAnchorElement ? control.href : null });
        control.click();
      }
    }
  });
})();
