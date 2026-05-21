/**
 * AgentGuard tray app — macOS menu bar entry point.
 *
 * Phase 1: surfaces daemon liveness only. No control actions yet.
 *
 *   Daemon liveness = whether the PID in ~/.agentguard/daemon.pid is alive.
 *   Status is polled every 5s and reflected in the context menu label.
 */

"use strict";

const { app, Tray, Menu, nativeImage } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PID_FILE = path.join(os.homedir(), ".agentguard", "daemon.pid");
const ICON_PATH = path.join(__dirname, "icon.png");
const POLL_INTERVAL_MS = 5000;

let tray = null;
let pollTimer = null;
let lastStatus = "checking...";

function readPid() {
  try {
    const raw = fs.readFileSync(PID_FILE, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function currentStatus() {
  const pid = readPid();
  return pid && isAlive(pid) ? "running" : "stopped";
}

function buildMenu(statusLabel) {
  return Menu.buildFromTemplate([
    { label: "AgentGuard", enabled: false },
    { label: `Daemon: ${statusLabel}`, enabled: false },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
}

function refresh() {
  const status = currentStatus();
  if (status === lastStatus) return;
  lastStatus = status;
  tray.setContextMenu(buildMenu(status));
}

app.whenReady().then(() => {
  if (process.platform === "darwin" && app.dock) {
    app.dock.hide();
  }

  const image = nativeImage.createFromPath(ICON_PATH);
  image.setTemplateImage(true);

  tray = new Tray(image);
  tray.setToolTip("AgentGuard");
  tray.setContextMenu(buildMenu("checking..."));

  refresh();
  pollTimer = setInterval(refresh, POLL_INTERVAL_MS);
});

app.on("window-all-closed", () => {
  // Tray-only app — do not quit when windows close (there are none).
});

app.on("before-quit", () => {
  if (pollTimer) clearInterval(pollTimer);
});
