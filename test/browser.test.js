import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { resolve, join } from "node:path";
import { test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";

const executable = process.env.COURSE_CHROME_BIN;

function devtools(chrome) {
  let sequence = 0;
  let remainder = "";
  const pending = new Map();
  chrome.stdio[4].setEncoding("utf8").on("data", chunk => {
    const records = (remainder + chunk).split("\0");
    remainder = records.pop();
    for (const record of records) {
      const message = JSON.parse(record);
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    }
  });
  chrome.once("exit", () => {
    for (const request of pending.values()) request.reject(new Error("Chrome 已退出"));
    pending.clear();
  });
  return (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
  });
}

function fixtureAudio() {
  const audio = Buffer.alloc(44 + 8000 * 2 * 2);
  audio.write("RIFF", 0);
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8000, 24);
  audio.writeUInt32LE(16000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(audio.length - 44, 40);
  return audio;
}

async function expectReady(check, label) {
  for (let attempt = 0; attempt < 95; attempt++) {
    const result = await check().catch(() => null);
    if (result) return result;
    await pause(80);
  }
  assert.fail("等待超时：" + label);
}

test("Chrome 扩展通过真实消息通道填写考试、Shadow DOM 与跨域课件 iframe 样例", {
  skip: !executable && "通过 COURSE_CHROME_BIN 指定 Chrome 路径",
  timeout: 45_000
}, async t => {
  const scratch = await mkdtemp(resolve(".chrome-fixture-"));
  const keyFile = join(scratch, "key.pem");
  const certFile = join(scratch, "cert.pem");
  let chrome;
  let server;
  t.after(async () => {
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
      const ended = once(chrome, "exit");
      chrome.kill();
      await ended;
    }
    server?.closeAllConnections();
    server?.close();
    await rm(scratch, { force: true, recursive: true });
  });

  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "1",
    "-subj", "/CN=fixture", "-keyout", keyFile, "-out", certFile], { stdio: "ignore" });
  const [cert, key, exam, iframe] = await Promise.all([
    readFile(certFile), readFile(keyFile),
    readFile(new URL("./fixtures/exam.html", import.meta.url)),
    readFile(new URL("./fixtures/iframe.html", import.meta.url))
  ]);
  const spki = createHash("sha256").update(new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" })).digest("base64");
  const requests = [];
  const imageRequests = [];
  let limitedRequest;
  let rejectMiddleAnswer = false;
  const audio = fixtureAudio();
  server = createServer({ cert, key }, async (request, response) => {
    if (request.url.startsWith("/clip/")) {
      response.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": audio.length });
      response.end(audio);
      return;
    }
    if (request.method === "POST" && request.url === "/api") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      const content = body.messages[1].content;
      const questions = JSON.parse(Array.isArray(content) ? content[0].text : content);
      if (!limitedRequest) {
        limitedRequest = { receivedAt: Date.now(), content };
        response.writeHead(429, { "Retry-After": "3" });
        response.end();
        return;
      }
      if (!requests.length) {
        assert.ok(Date.now() - limitedRequest.receivedAt >= 3000);
        assert.deepEqual(content, limitedRequest.content);
      }
      if (Array.isArray(content)) imageRequests.push(content.slice(1));
      requests.push(questions);
      const answers = rejectMiddleAnswer && questions[0].text === "样例题 4" ? [] :
        questions.map(question => question.kind === "text" ? ["24", "7"] :
          question.text.includes("二加二") ? [2] : [1]);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answers }) } }] }));
      return;
    }
    const port = server.address().port;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (request.url === "/learn/exam") response.end(exam);
    else if (request.url === "/work/2") response.end(iframe);
    else if (request.url === "/learn/episode/1") response.end(`<!doctype html><meta charset=utf-8>
      <video muted controls width="320" height="180" src="/clip/1"></video>
      <a href="/learn/episode/2#/learn/content?type=detail&id=2">下一集</a>`);
    else if (request.url === "/learn/episode/2") response.end(`<!doctype html><meta charset=utf-8>
      <div class="u-learnBCUI"><div class="j-lesson"><div class="u-select">
        <div class="j-up">第一小节</div>
        <div class="j-list" hidden><div class="list">第一小节</div><div class="list">第二小节</div></div>
      </div></div></div>
      <div class="videoDetail"><div class="mooc-video-player">
        <video muted controls width="320" height="180" src="/clip/2"></video>
      </div></div>
      <script>
        document.querySelector(".j-up").onclick = () => { document.querySelector(".j-list").hidden = false; };
        document.querySelector(".list:last-child").onclick = event => {
          history.pushState({}, "", "/learn/episode/3#/learn/content?type=detail&id=3");
          document.querySelector("video").src = "/clip/3";
          event.currentTarget.closest(".u-learnBCUI").remove();
        };
      </script>`);
    else if (/^\/lesson\/[12]$/.test(request.url)) {
      const number = request.url.at(-1);
      response.end(`<!doctype html><meta charset=utf-8><title>课程视频</title>
        <iframe width="400" height="220" src="https://embed.icourse163.org:${port}/video-frame/${number}"></iframe>
        ${number === "1" ? '<a href="/lesson/2">下一节</a>' : ""}`);
    } else if (/^\/video-frame\/[12]$/.test(request.url)) {
      response.end(`<!doctype html><meta charset=utf-8><video muted controls width="320" height="180"
        src="/clip/${request.url.at(-1)}"></video>`);
    } else response.end(`<!doctype html><meta charset=utf-8><title>章节作业</title>
      <iframe src="https://embed.icourse163.org:${port}/work/2"></iframe>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const mooc = "https://www.icourse163.org:" + port;

  chrome = spawn(executable, ["--headless=new", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--no-proxy-server", "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging", "--user-data-dir=" + join(scratch, "profile"),
    "--ignore-certificate-errors-spki-list=" + spki,
    "--host-resolver-rules=MAP www.icourse163.org 127.0.0.1, MAP embed.icourse163.org 127.0.0.1, MAP edu-image.nosdn.127.net ~NOTFOUND",
    "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const send = devtools(chrome);
  const { id } = await send("Extensions.loadUnpacked", { path: resolve("extension") });
  const ext = "chrome-extension://" + id;

  async function open(url, background = false) {
    const { targetId } = await send("Target.createTarget", { url, background });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    return { targetId, sessionId };
  }

  async function evaluate(tab, expression, userGesture = false) {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true,
      returnByValue: true, userGesture, contextId: tab.contextId }, tab.sessionId);
    if (result.exceptionDetails) throw new Error(result.result.description);
    return result.result.value;
  }

  const options = await open(ext + "/options.html");
  await expectReady(() => evaluate(options, 'document.getElementById("save")?.disabled === false'), "API 设置");
  await evaluate(options, `document.getElementById("url").value = ${JSON.stringify(mooc + "/api")};
    document.getElementById("model").value = "fixture"; document.getElementById("save").click();`, true);
  await expectReady(() => evaluate(options, 'document.getElementById("status").textContent === "已保存。"'), "API 授权");

  async function popupFor(tab) {
    await send("Target.activateTarget", { targetId: tab.targetId });
    const popup = await open(ext + "/popup.html", true);
    await expectReady(() => evaluate(popup, 'document.getElementById("questions")?.disabled === false'), "扩展面板");
    return popup;
  }

  const examTab = await open(mooc + "/learn/exam");
  await expectReady(() => evaluate(examTab, 'Boolean(document.querySelector("#submit"))'), "考试页面");
  let popup = await popupFor(examTab);
  await expectReady(() => evaluate(popup, 'document.getElementById("player").options.length === 3'), "播放器列表");
  await evaluate(popup, `(() => { const control = document.getElementById("rate");
    control.value = "2"; control.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await expectReady(() => evaluate(examTab, 'document.querySelectorAll("video")[1]?.playbackRate === 2'), "主播放器 2×");
  assert.equal(await evaluate(examTab, 'document.querySelector("video").playbackRate'), 1);
  await evaluate(popup, `(() => { const control = document.getElementById("player");
    control.value = "0"; control.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await expectReady(() => evaluate(examTab, 'document.querySelector("video").playbackRate === 2'), "手动切换播放器");

  await evaluate(popup, `(() => { const control = document.getElementById("rate");
    control.value = "16"; control.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await expectReady(() => evaluate(examTab, 'document.querySelector("video").playbackRate === 16'), "16× 倍速");
  assert.deepEqual(await evaluate(examTab, `(() => {
    const video = document.querySelector("video");
    video.src = "/clip/1";
    video.load();
    return [video.defaultPlaybackRate, video.playbackRate];
  })()`), [16, 16], "更换视频源时保留 16×");
  assert.equal(await evaluate(examTab, `(() => {
    const probe = document.createElement("video");
    try { probe.playbackRate = 32; } catch (error) { return error.name; }
    return probe.playbackRate;
  })()`), "NotSupportedError");
  await evaluate(popup, `(() => { const control = document.getElementById("rate");
    control.value = "0.25"; control.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await expectReady(() => evaluate(examTab, 'document.querySelector("video").playbackRate === 0.25'), "0.25× 倍速");
  await evaluate(popup, `(() => { const control = document.getElementById("rate");
    control.value = "0"; control.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await expectReady(() => evaluate(examTab, `(() => {
    const video = document.querySelector("video");
    return video.defaultPlaybackRate === 1 && video.playbackRate === 1;
  })()`), "恢复网页原本的默认速度和播放速度");
  await evaluate(popup, `(() => { const control = document.getElementById("rate");
    control.value = "2"; control.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await expectReady(() => evaluate(examTab, 'document.querySelector("video").playbackRate === 2'), "恢复测试倍速");

  await evaluate(popup, 'document.getElementById("solve").click()');
  await expectReady(() => evaluate(popup, 'document.getElementById("status").textContent.includes("秒后自动重试")'),
    "显示限流倒计时");
  await send("Target.closeTarget", { targetId: popup.targetId });
  await evaluate(examTab, `(() => {
    const input = document.getElementById("math-b");
    input.replaceWith(input.cloneNode());
  })()`);
  await expectReady(() => evaluate(examTab,
    'document.getElementById("math-b").checked && document.body.dataset.blank1 === "7"'),
    "关闭面板后自动写入重新渲染的控件并填完");
  popup = await popupFor(examTab);
  await expectReady(() => evaluate(popup, 'document.getElementById("status").textContent.startsWith("已填写 2 题")'),
    "重新打开面板后查看任务结果");
  assert.equal(requests[0][0].text, "二加二等于多少？ [图1]");
  assert.deepEqual(requests[0][0].options, ["三", "[图2]"]);
  assert.deepEqual(imageRequests, [[
    { type: "text", text: "第 1 题的 [图1]" },
    { type: "image_url", image_url: { url: "https://edu-image.nosdn.127.net/fixture-formula.png" } },
    { type: "text", text: "第 1 题的 [图2]" },
    { type: "image_url", image_url: { url: "https://edu-image.nosdn.127.net/fixture-option.png" } }
  ]]);
  assert.deepEqual(await evaluate(examTab, `[document.querySelectorAll("input[type=radio]")[1].checked,
    document.body.dataset.blank0, document.body.dataset.blank1,
    document.querySelector("input[type=text]").value, document.body.dataset.submitted ?? null]`),
  [true, "24", "7", "中国", null]);

  async function frameContext(tab, path) {
    const frame = await expectReady(async () => {
      const { frameTree } = await send("Page.getFrameTree", {}, tab.sessionId);
      return frameTree.childFrames?.find(child => child.frame.url.endsWith(path))?.frame;
    }, path);
    const { executionContextId } = await send("Page.createIsolatedWorld", { frameId: frame.id }, tab.sessionId);
    return { ...tab, contextId: executionContextId };
  }

  const course = await open(mooc + "/course");
  const assignmentFrame = await frameContext(course, "/work/2");
  const coursePopup = await popupFor(course);
  await evaluate(coursePopup, 'document.getElementById("solve").click()');
  await expectReady(() => evaluate(assignmentFrame,
    'document.querySelector("#task-true")?.checked'), "跨域 iframe 填答隐藏单选");
  assert.deepEqual(requests[2][0].options, ["正确", "错误"]);
  assert.deepEqual(imageRequests[1], [
    { type: "text", text: "第 1 题的 [图1]" },
    { type: "image_url", image_url: {
      url: "https://edu-image.nosdn.127.net/assignment-figure.png"
    } }
  ]);
  assert.equal(await evaluate(assignmentFrame, 'document.body.dataset.submitted ?? null'), null);
  assert.deepEqual(requests.map(batch => batch.length), [1, 1, 1]);

  await send("Target.activateTarget", { targetId: examTab.targetId });
  await evaluate(examTab, `(() => {
    for (let index = 0; index < 9; index++) {
      const field = document.createElement("fieldset");
      field.className = "batch-probe";
      const title = document.createElement("legend");
      title.textContent = "样例题 " + index;
      field.append(title);
      for (const option of ["甲", "乙"]) {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "radio";
        input.name = "probe-" + index;
        label.append(input, option);
        field.append(label);
      }
      document.body.append(field);
    }
  })()`);
  rejectMiddleAnswer = true;
  await evaluate(popup, 'document.getElementById("solve").click()');
  await expectReady(() => evaluate(popup, 'document.getElementById("status").textContent.includes("数量与题目数量不符")'),
    "单题答案数量错误后继续填写");
  assert.equal(await evaluate(examTab, 'document.querySelectorAll(".batch-probe input:checked").length'), 8);
  assert.deepEqual(await evaluate(examTab, '[4, 8].map(index => document.querySelector(".batch-probe input[name=probe-"+index+"]").checked)'),
    [false, true]);
  assert.deepEqual(requests.map(batch => batch.length), Array(12).fill(1));

  await t.test("视频真实播完后自动打开下一集，并在普通导航和 SPA 导航后自动播放", async () => {
    const episode = await open(mooc + "/learn/episode/1");
    await expectReady(() => evaluate(episode, 'document.querySelector("video")?.readyState > 0'), "第一集视频");
    const episodePopup = await popupFor(episode);
    await expectReady(() => evaluate(episodePopup, 'document.getElementById("player").options.length === 2'),
      "第一集播放器已接管");
    assert.equal(await evaluate(episodePopup, 'document.getElementById("nextEpisode").checked'), false);
    await evaluate(episodePopup, 'document.getElementById("nextEpisode").click()');
    await expectReady(() => evaluate(episodePopup, 'chrome.storage.sync.get("playback").then(({playback}) => playback.nextEpisode)'),
      "自动下一集设置已保存");
    await evaluate(episode, 'document.querySelector("video").dispatchEvent(new Event("ended"))');
    assert.equal(await evaluate(episode, 'location.pathname'), "/learn/episode/1");
    await evaluate(episode, 'document.querySelector("video").play()', true);
    await expectReady(() => evaluate(episode, 'location.pathname === "/learn/episode/2" && document.querySelector("video")?.currentTime > 0'),
      "第二集已自动播放");
    await expectReady(() => evaluate(episode, 'location.pathname === "/learn/episode/3" && document.querySelector("video")?.currentTime > 0'),
      "SPA 切换后第三集已自动播放");
  });

  await t.test("慕课样例从跨域视频框架触发外层下一节并继续播放", async () => {
    const lesson = await open(mooc + "/lesson/1");
    const currentPlayer = await frameContext(lesson, "/video-frame/1");
    await expectReady(() => evaluate(currentPlayer, 'document.querySelector("video")?.readyState > 0'), "慕课第一节视频");
    const lessonPopup = await popupFor(lesson);
    await expectReady(() => evaluate(lessonPopup, 'document.getElementById("player").options.length === 2'),
      "跨域播放器已接管");
    await evaluate(lessonPopup, 'if (!document.getElementById("nextEpisode").checked) document.getElementById("nextEpisode").click()');
    await expectReady(() => evaluate(lessonPopup, 'chrome.storage.sync.get("playback").then(({playback}) => playback.nextEpisode)'),
      "慕课的自动下一集已启用");
    await evaluate(currentPlayer, 'document.querySelector("video").play()', true);
    const nextPlayer = await frameContext(lesson, "/video-frame/2");
    await expectReady(() => evaluate(nextPlayer, 'document.querySelector("video")?.currentTime > 0'), "慕课下一节已自动播放");
    assert.equal(await evaluate(lesson, 'location.pathname'), "/lesson/2");
  });
});
