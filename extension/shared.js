(() => {
  "use strict";

  const sites = {
    mooc: { name: "中国大学 MOOC", domains: ["icourse163.org"] }
  };
  const rates = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3,
    4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  const playbackDefaults = { rate: 0, autoplay: false, next: false, nextEpisode: false };
  const maxBatch = 8;
  const maxBatchImages = 12;
  const maxAnswerLength = 4000;

  function parseUrl(value) {
    try { return new URL(value); } catch { return null; }
  }

  function platform(value) {
    const url = parseUrl(value);
    if (url?.protocol !== "https:") return null;
    return Object.entries(sites).find(([, { domains }]) =>
      domains.some(domain => url.hostname === domain || url.hostname.endsWith("." + domain))
    )?.[0] ?? null;
  }

  function courseFrames(frames) {
    const top = frames.find(frame => frame.frameId === 0);
    if (!platform(top?.url)) return [];
    const byId = new Map(frames.map(frame => [frame.frameId, frame]));
    return frames.filter(frame => {
      let current = frame;
      while (current) {
        if (current.frameId === 0) return true;
        if (!platform(current.url) && !/^about:(blank|srcdoc)$/.test(current.url)) return false;
        current = byId.get(current.parentFrameId);
      }
      return false;
    });
  }

  function assessmentMode(value, title = "", markers = "") {
    const url = parseUrl(value);
    const route = (url?.pathname ?? "") + (url?.hash ?? "");
    if (/(?:exam|kaoshi|finalexam|midterm|proctor|paperTest|试卷|考试)/i.test(route) ||
        /考试|考场|考生|试卷|交卷|剩余时间|答题倒计时|proctored|\bexam(?:ination)?\b/i.test(title + " " + markers)) return "exam";
    if (/(?:homework|\/work|workdetail|workdo|quiz|assessment|assignment|exercise|practice|chaptertest|test(?:list|detail|do|\/|$))/i.test(route) ||
        /作业|测验|练习|自测|答题|quiz|homework|assignment/i.test(title)) return "practice";
    return "unknown";
  }

  function endpoint(value) {
    const url = parseUrl(value);
    if (!url || url.href.length > 2048) throw new Error("请输入有效的 API 地址。");
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!(url.protocol === "https:" || (loopback && url.protocol === "http:")) ||
        url.username || url.password || url.hash) {
      throw new Error("API 地址须使用 HTTPS（本机除外），且不能包含内嵌凭据或锚点。");
    }
    return url;
  }

  function apiOrigin(url) {
    return `${url.protocol}//${url.hostname}/*`;
  }

  function apiCredentials(model, key) {
    if (typeof model !== "string" || !model.trim() || model.length > 160) throw new Error("请输入有效的模型名称。");
    if (typeof key !== "string" || !/^[\x21-\x7e]{0,4096}$/.test(key)) throw new Error("API 密钥不可含空格或换行。");
  }

  function questionImageUrl(value) {
    const url = typeof value === "string" && value.length <= 2048 ? parseUrl(value) : null;
    if (url?.origin !== "https://edu-image.nosdn.127.net" || url.username || url.password ||
        !/\.(?:png|jpe?g|gif|webp)$/i.test(url.pathname)) return null;
    return url.origin + url.pathname;
  }

  function questionIsValid(question) {
    if (!question || !["single", "multiple", "text"].includes(question.kind) ||
        typeof question.text !== "string" || !question.text.trim() || question.text.length > 6000 ||
        !Array.isArray(question.options) || question.options.length > 26 ||
        !question.options.every(option => typeof option === "string" && option.trim() && option.length <= 2000)) return false;
    if (question.images !== undefined && (!Array.isArray(question.images) || question.images.length > maxBatchImages ||
        !question.images.every(url => typeof url === "string" && questionImageUrl(url) === url))) return false;
    if (question.kind === "text") return question.options.length === 0 &&
      Number.isInteger(question.blanks) && question.blanks >= 1 && question.blanks <= 12;
    return question.options.length >= 2;
  }

  function parseAnswer(question, answer) {
    if (!Array.isArray(answer)) return null;
    if (question.kind === "text") {
      if (answer.length !== question.blanks || answer.some(value =>
        typeof value !== "string" || !value.trim() || value.length > maxAnswerLength)) return null;
      return answer.map(value => value.trim());
    }
    if ((question.kind === "single" ? answer.length !== 1 : answer.length < 2) ||
        answer.some(index => !Number.isInteger(index) || index < 1 || index > question.options.length) ||
        new Set(answer).size !== answer.length) return null;
    return answer;
  }

  function mainVideo(videos) {
    return videos.reduce((largest, video) =>
      !largest || video.area > largest.area ? video : largest, null);
  }

  globalThis.CourseAssistant = {
    sites, rates, playbackDefaults, maxBatch, maxBatchImages, platform, courseFrames,
    assessmentMode, endpoint, apiOrigin, apiCredentials, questionImageUrl, questionIsValid, parseAnswer, mainVideo
  };
})();
