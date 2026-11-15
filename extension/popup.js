const { sites, rates, playbackDefaults, platform } = CourseAssistant;
const byId = id => document.getElementById(id);
const rate = byId("rate");
const autoplay = byId("autoplay");
const next = byId("next");
const nextEpisode = byId("nextEpisode");
const player = byId("player");
const solveButton = byId("solve");
const status = byId("status");
let tab;
let playerChoices = [];

rate.add(new Option("跟随网页", 0));
byId("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
byId("playback").addEventListener("change", async event => {
  if (event.target === player) return;
  try {
    await chrome.storage.sync.set({
      playback: { rate: Number(rate.value), autoplay: autoplay.checked, next: next.checked, nextEpisode: nextEpisode.checked }
    });
    await refreshPlayers();
  } catch {
    status.textContent = "保存播放设置失败。";
  }
});

async function refreshPlayers(selection) {
  const result = await chrome.runtime.sendMessage({ action: "media", tabId: tab.id, selection });
  if (!result || result.error) throw new Error(result?.error || "无法识别播放器。");
  renderPlayers(result);
}

function renderPlayers(result) {
  playerChoices = result.videos;
  player.replaceChildren(new Option(playerChoices.length ? "自动选主播放器" : "当前页暂无播放器", ""));
  for (const [index, video] of playerChoices.entries()) {
    const title = "视频 " + (index + 1) + (video.label ? " · " + video.label : "");
    player.add(new Option(title, String(index)));
    if (video.documentId === result.selected?.documentId && video.id === result.selected?.id) player.value = String(index);
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id === chrome.runtime.id && !sender.tab && message?.action === "mediaUpdated" &&
      message.tabId === tab?.id && Array.isArray(message.result?.videos)) {
    renderPlayers(message.result);
  }
});

player.addEventListener("change", async () => {
  const choice = player.value === "" ? null : playerChoices[Number(player.value)];
  try {
    await refreshPlayers(choice ? { documentId: choice.documentId, id: choice.id } : null);
  } catch (error) {
    status.textContent = error.message;
  }
});

let progressTimer;
let progressVersion = 0;

async function solveStatus(action) {
  const version = ++progressVersion;
  clearTimeout(progressTimer);
  if (action === "startSolve") solveButton.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ action, tabId: tab.id });
    if (version !== progressVersion) return;
    if (!result || result.error) throw new Error(result?.error || "无法连接当前页面。");
    if (result.message) status.textContent = result.message;
    solveButton.disabled = Boolean(result.running);
    if (result.running) progressTimer = setTimeout(() => solveStatus("solveStatus"), 500);
  } catch (error) {
    if (version !== progressVersion) return;
    status.textContent = error.message;
    solveButton.disabled = false;
  }
}

solveButton.addEventListener("click", () => solveStatus("startSolve"));

async function initialize() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const site = platform(tab?.url);
  byId("platform").textContent = sites[site]?.name ?? "请打开中国大学 MOOC 的课程页";
  if (!site) return;

  const { playback: saved } = await chrome.storage.sync.get("playback");
  const playback = { ...playbackDefaults, ...saved };
  for (const value of rates) rate.add(new Option(value + "×", value));
  rate.value = rates.includes(playback.rate) ? playback.rate : playbackDefaults.rate;
  autoplay.checked = playback.autoplay;
  next.checked = playback.next;
  nextEpisode.checked = playback.nextEpisode;
  byId("playback").disabled = false;
  byId("questions").disabled = false;
  await Promise.all([refreshPlayers(), solveStatus("solveStatus")]);
}

initialize().catch(error => { status.textContent = error.message || "读取扩展设置失败。"; });
