const DEFAULT_SETTINGS = {
  topSize: 3,
  recentMinVisibleSeconds: 5,
  workActivityKinds: ["typing", "clipboard", "selection", "pointer", "scroll"],
  pointerWorkThreshold: 5,
  statsWindowMode: "rolling-active-24h",
  allowlist: "",
  blocklist: "",
  customLogoDataUrl: "",
  themeMode: "system"
};

const form = document.querySelector("#settings-form");
const topSize = document.querySelector("#top-size");
const recentSeconds = document.querySelector("#recent-seconds");
const statsWindowMode = document.querySelector("#stats-window-mode");
const pointerWorkThreshold = document.querySelector("#pointer-work-threshold");
const workActivityKinds = [...document.querySelectorAll('input[name="work-activity-kind"]')];
const allowlist = document.querySelector("#allowlist");
const blocklist = document.querySelector("#blocklist");
const logoUploadInput = document.querySelector("#logo-upload-input");
const clearLogoButton = document.querySelector("#clear-logo-button");
const logoPreview = document.querySelector("#logo-preview");
const logoPlaceholder = document.querySelector("#logo-placeholder");
const logoMeta = document.querySelector("#logo-meta");
const resetButton = document.querySelector("#reset-button");
const status = document.querySelector("#status");

let pendingLogoDataUrl = "";
let currentThemeMode = "system";
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");

applyTheme("system");
loadSettings().catch(showFailure);
systemTheme.addEventListener("change", () => {
  if (currentThemeMode === "system") {
    applyTheme("system");
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    if (!canUseRuntime()) {
      throw new Error("runtime-unavailable");
    }

    const settings = readForm();
    const response = await chrome.runtime.sendMessage({ type: "save-settings", settings });
    if (!response?.ok) {
      throw new Error(response?.error || "save-failed");
    }

    fillForm(response.settings);
    showStatus("设置已保存。");
  } catch (error) {
    showFailure(error);
  }
});

resetButton.addEventListener("click", () => {
  fillForm(DEFAULT_SETTINGS);
  showStatus("已恢复默认值，点击保存后生效。");
});

logoUploadInput.addEventListener("change", async () => {
  const [file] = logoUploadInput.files || [];
  if (!file) {
    return;
  }

  try {
    pendingLogoDataUrl = await normalizeLogoFile(file);
    renderLogoPreview(pendingLogoDataUrl);
    logoMeta.textContent = `已选择 ${file.name}`;
    await persistLogoSettings();
  } catch (error) {
    showFailure(error);
  } finally {
    logoUploadInput.value = "";
  }
});

clearLogoButton.addEventListener("click", () => {
  void clearCustomLogo();
});

async function loadSettings() {
  if (!canUseRuntime()) {
    throw new Error("runtime-unavailable");
  }

  const response = await chrome.runtime.sendMessage({ type: "get-settings" });
  if (!response?.ok) {
    throw new Error(response?.error || "load-failed");
  }

  fillForm(response.settings);
}

async function clearCustomLogo() {
  try {
    pendingLogoDataUrl = "";
    renderLogoPreview("");
    logoMeta.textContent = "当前使用默认图标。";
    await persistLogoSettings();
  } catch (error) {
    showFailure(error);
  }
}

async function persistLogoSettings() {
  if (!canUseRuntime()) {
    throw new Error("runtime-unavailable");
  }

  const response = await chrome.runtime.sendMessage({
    type: "save-settings",
    settings: readForm()
  });
  if (!response?.ok) {
    throw new Error(response?.error || "save-failed");
  }

  fillForm(response.settings);
  showStatus("图标已更新。");
}

function readForm() {
  return {
    topSize: Number(topSize.value),
    recentMinVisibleSeconds: Number(recentSeconds.value),
    statsWindowMode: statsWindowMode.value,
    workActivityKinds: workActivityKinds
      .filter((input) => input.checked)
      .map((input) => input.value),
    pointerWorkThreshold: Number(pointerWorkThreshold.value),
    allowlist: allowlist.value,
    blocklist: blocklist.value,
    customLogoDataUrl: pendingLogoDataUrl,
    themeMode: currentThemeMode
  };
}

function fillForm(settings) {
  const safeSettings = normalizeSettings(settings);
  topSize.value = safeSettings.topSize;
  recentSeconds.value = safeSettings.recentMinVisibleSeconds;
  statsWindowMode.value = safeSettings.statsWindowMode;

  const selectedKinds = new Set(safeSettings.workActivityKinds);
  for (const input of workActivityKinds) {
    input.checked = selectedKinds.has(input.value);
  }

  pointerWorkThreshold.value = String(safeSettings.pointerWorkThreshold);
  allowlist.value = safeSettings.allowlist;
  blocklist.value = safeSettings.blocklist;
  pendingLogoDataUrl = safeSettings.customLogoDataUrl || "";
  currentThemeMode = safeSettings.themeMode;
  applyTheme(currentThemeMode);
  renderLogoPreview(pendingLogoDataUrl);
  logoMeta.textContent = pendingLogoDataUrl ? "当前使用自定义图标。" : "未上传自定义图标。";
}

function normalizeSettings(settings) {
  return {
    ...DEFAULT_SETTINGS,
    ...(settings || {}),
    workActivityKinds: Array.isArray(settings?.workActivityKinds)
      ? settings.workActivityKinds
      : DEFAULT_SETTINGS.workActivityKinds,
    pointerWorkThreshold: Number.isFinite(Number(settings?.pointerWorkThreshold))
      ? Math.max(1, Math.round(Number(settings.pointerWorkThreshold)))
      : DEFAULT_SETTINGS.pointerWorkThreshold,
    customLogoDataUrl:
      typeof settings?.customLogoDataUrl === "string" ? settings.customLogoDataUrl : "",
    themeMode: ["system", "light", "dark"].includes(settings?.themeMode)
      ? settings.themeMode
      : DEFAULT_SETTINGS.themeMode
  };
}

function applyTheme(mode) {
  const resolved = mode === "system" ? (systemTheme.matches ? "dark" : "light") : mode;
  document.documentElement.dataset.theme = resolved;
}

function renderLogoPreview(dataUrl) {
  if (dataUrl) {
    logoPreview.src = dataUrl;
    logoPreview.hidden = false;
    logoPlaceholder.hidden = true;
    return;
  }

  logoPreview.removeAttribute("src");
  logoPreview.hidden = true;
  logoPlaceholder.hidden = false;
}

async function normalizeLogoFile(file) {
  if (!file.type.startsWith("image/")) {
    throw new Error("invalid-logo-file");
  }

  const dataUrl = await readFileAsDataUrl(file);
  const image = await loadImage(dataUrl);
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext("2d");
  const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
  const sourceX = Math.round((image.naturalWidth - sourceSize) / 2);
  const sourceY = Math.round((image.naturalHeight - sourceSize) / 2);

  context.clearRect(0, 0, size, size);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, size, size);
  return canvas.toDataURL("image/png");
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("logo-read-failed"));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("logo-load-failed"));
    image.src = dataUrl;
  });
}

function canUseRuntime() {
  return Boolean(globalThis.chrome?.runtime?.sendMessage);
}

function showStatus(message) {
  status.textContent = message;
  window.setTimeout(() => {
    status.textContent = "";
  }, 2500);
}

function showFailure(error) {
  console.error(error);
  if (error?.message === "runtime-unavailable") {
    status.textContent = "这个设置页已经失效了。请关闭它，并从扩展里重新打开设置页。";
    return;
  }

  if (error?.message === "invalid-logo-file") {
    status.textContent = "上传失败，请选择 PNG、JPG、WebP 或 SVG 图片。";
    return;
  }

  status.textContent = "操作失败，请重新加载扩展后重试。";
}
