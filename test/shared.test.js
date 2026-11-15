import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import "../extension/shared.js";

const { platform, endpoint, apiOrigin, apiCredentials, assessmentMode, courseFrames,
  questionImageUrl, questionIsValid, parseAnswer, mainVideo } = CourseAssistant;
const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"));

test("含公式图的题限制图片来源", () => {
  const base = "https://edu-image.nosdn.127.net/";
  const questions = Array.from({ length: 5 }, (_, number) => ({
    kind: "single",
    text: "计算 [图1]",
    options: ["甲", "乙"],
    images: Array.from({ length: 5 }, (_, image) => base + number + "-" + image + ".png")
  }));
  assert.ok(questions.every(questionIsValid));
  assert.equal(questionImageUrl(base + "figure.png?token=private#fragment"), base + "figure.png");
  for (const image of [null, "http://127.0.0.1/figure.png", "https://edu-image.nosdn.127.net.example.com/figure.png"]) {
    assert.equal(questionIsValid({ ...questions[0], images: [image] }), false);
  }
});

test("平台识别仅匹配支持的 HTTPS 域名及其子域", () => {
  assert.equal(platform("https://www.icourse163.org/learn/example"), "mooc");
  assert.equal(platform("https://icourse163.org/"), "mooc");
  for (const value of [
    "https://icourse163.org.example.com/", "https://mooc1.chaoxing.com/", "https://www.xuexitong.com/",
    "http://www.icourse163.org/", "https://icourse163.org@other.example/", "about:blank", undefined
  ]) assert.equal(platform(value), null);
});

test("扩展注入域名与权限一致，支持嵌套课件", () => {
  const [content] = manifest.content_scripts;
  assert.equal(manifest.manifest_version, 3);
  assert.equal(content.all_frames, true);
  assert.equal(content.match_about_blank, true);
  assert.deepEqual(content.matches, manifest.host_permissions);
  assert.deepEqual(content.matches, ["https://*.icourse163.org/*"]);
  for (const match of content.matches) assert.ok(platform(match.replace("*.", "example.")));
});

test("API 地址要求 HTTPS 或本机 HTTP 且禁止内嵌凭据", () => {
  assert.equal(endpoint("https://api.example.com:8443/v1/chat/completions").port, "8443");
  assert.equal(apiOrigin(endpoint("http://127.0.0.1:5150/api")), "http://127.0.0.1/*");
  assert.equal(endpoint("http://[::1]:7200/api").hostname, "[::1]");
  assert.throws(() => apiCredentials("model", "bad\r\nheader"));
  for (const value of [
    "example.com", "http://api.example.com/", "https://user:secret@api.example.com/",
    "https://api.example.com/#fragment", "file:///etc/config"
  ]) assert.throws(() => endpoint(value), Error);
});

test("验证题目和选项的类型、数量与长度", () => {
  const question = { kind: "single", text: "选择一个答案", options: ["甲", "乙"] };
  assert.ok(questionIsValid(question));
  assert.ok(questionIsValid({ ...question, kind: "text", options: [], blanks: 1 }));
  assert.ok(!questionIsValid({ ...question, text: " " }));
  assert.ok(!questionIsValid({ ...question, text: "题".repeat(6001) }));
  assert.ok(!questionIsValid({ ...question, options: ["甲"] }));
  assert.ok(!questionIsValid({ ...question, options: ["甲", 2] }));
  assert.ok(!questionIsValid({ ...question, kind: "text" }));
});

test("只接受题型对应的合法答案", () => {
  const single = { kind: "single", options: ["甲", "乙", "丙"] };
  const multiple = { ...single, kind: "multiple" };
  const text = { kind: "text", options: [], blanks: 1 };
  assert.deepEqual(parseAnswer(single, [3]), [3]);
  assert.deepEqual(parseAnswer(multiple, [1, 3]), [1, 3]);
  for (const value of [null, "1", ["1"], [0], [4], [1.5], [1, 2], []]) {
    assert.equal(parseAnswer(single, value), null);
  }
  assert.equal(parseAnswer(multiple, [2, 2]), null);
  assert.deepEqual(parseAnswer(text, ["  正确  "]), ["正确"]);
  assert.equal(parseAnswer(multiple, [1]), null);
  assert.equal(parseAnswer(text, [" "]), null);
  assert.equal(parseAnswer(text, ["答".repeat(4001)]), null);
  assert.equal(parseAnswer({ ...text, blanks: 2 }, ["一个"]), null);
  assert.deepEqual(parseAnswer({ ...text, blanks: 2 }, [" 甲 ", "乙"]), ["甲", "乙"]);
});


test("允许考试与作业，未知页面维持未知", () => {
  assert.equal(assessmentMode("https://www.icourse163.org/course#/learn/examlist"), "exam");
  assert.equal(assessmentMode("https://www.icourse163.org/work/1", "章节作业"), "practice");
  assert.equal(assessmentMode("https://school.example/session/1", "", "试卷 剩余时间"), "exam");
  assert.equal(assessmentMode("https://www.icourse163.org/course", "课程介绍"), "unknown");
});

test("慕课允许课件子域，并跳过外部站点及其空白子帧", () => {
  const frames = [
    { frameId: 0, parentFrameId: -1, url: "https://www.icourse163.org/course" },
    { frameId: 1, parentFrameId: 0, url: "https://embed.icourse163.org/work" },
    { frameId: 2, parentFrameId: 1, url: "about:blank" },
    { frameId: 3, parentFrameId: 0, url: "https://another.example/frame" },
    { frameId: 4, parentFrameId: 3, url: "about:srcdoc" }
  ];
  assert.deepEqual(courseFrames(frames).map(frame => frame.frameId), [0, 1, 2]);
  assert.deepEqual(courseFrames([{ ...frames[0], url: "https://another.example/course" }, ...frames.slice(1)]), []);
});

test("自动选择面积最大的播放器", () => {
  assert.equal(mainVideo([{ id: "preview", area: 100 }, { id: "lesson", area: 500 }]).id, "lesson");
  assert.equal(mainVideo([]), null);
});
