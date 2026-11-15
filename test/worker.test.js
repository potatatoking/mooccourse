import assert from "node:assert/strict";
import { test } from "node:test";

const id = "fixture";
const popup = "chrome-extension://fixture/popup.html";
const api = { url: "https://api.example.com/v1/chat/completions", key: "mock-token", model: "test-model" };
let listener;
let authorized = true;
globalThis.chrome = {
  storage: { local: { get: async () => ({ api }), setAccessLevel: async () => {} } },
  permissions: { contains: async () => authorized },
  runtime: {
    id,
    getURL: path => "chrome-extension://fixture/" + path,
    onMessage: { addListener: callback => { listener = callback; } }
  }
};
await import("../extension/worker.js");

const question = { kind: "single", text: "二加二等于多少？", options: ["三", "四"] };
const message = { action: "solve", questions: [question] };
const send = (data = message) => new Promise(resolve => {
  assert.equal(listener(data, { id, url: popup }, resolve), true);
});
const apiReply = content => Response.json({ choices: [{ message: { content } }] });

test("API 只接收题目、题型与选项，并校验返回内容", async t => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url.href, api.url);
    assert.equal(options.headers.Authorization, "Bearer mock-token");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    const body = JSON.parse(options.body);
    assert.equal(body.model, "test-model");
    assert.deepEqual(JSON.parse(body.messages[1].content), [question]);
    return apiReply('{"answers":[[2]]}');
  });

  assert.deepEqual(await send({
    ...message, questions: [{ ...question, from: "https://fixture.example/secret" }]
  }), { answers: [[2]] });
});

test("拒绝其他上下文触发答题", () => {
  assert.equal(listener(message, { id, url: "https://www.icourse163.org/" }, assert.fail), false);
  assert.equal(listener(message, { id: "another-extension", url: popup }, assert.fail), false);
});

test("未获 API 域名授权时不会发请求", async t => {
  t.mock.method(globalThis, "fetch", assert.fail);
  authorized = false;
  try {
    assert.match((await send()).error, /重新授权/);
  } finally {
    authorized = true;
  }
});

test("处理无效答案、超限响应及 HTTP 错误", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => apiReply('{"answers":[[7]]}'));
  assert.match((await send()).error, /不符合题型/);
  fetch.mock.mockImplementation(async () => apiReply('{"answers":[null]}'));
  assert.deepEqual(await send(), { answers: [null] });

  fetch.mock.mockImplementation(async () => apiReply('{"answers":[]}'));
  assert.match((await send()).error, /数量/);

  fetch.mock.mockImplementation(async () => new Response("x".repeat(1024 * 1024 + 1)));
  assert.match((await send()).error, /1 MB/);

});

test("限流时尊重 Retry-After，并暂停向同一个接口发送请求", async t => {
  const originalUrl = api.url;
  api.url = "https://limited.example.com/chat/completions";
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    new Response(null, { status: 429, headers: { "Retry-After": "60" } }));
  try {
    const [initial, queued] = await Promise.all([send(), send()]);
    assert.deepEqual(initial, { retryAfterMs: 60_000 });
    assert.ok(queued.retryAfterMs > 59_000 && queued.retryAfterMs <= 60_000);
    assert.equal(fetch.mock.callCount(), 1);
  } finally {
    api.url = originalUrl;
  }
});

test("短暂服务错误时只重试一次", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  fetch.mock.mockImplementationOnce(async () => new Response(null, { status: 503 }));
  assert.match((await send()).error, /HTTP 503/);
  assert.equal(fetch.mock.callCount(), 2);
});
