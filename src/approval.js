/**
 * AgentGuard Approval Prompt
 *
 * Renders a bordered approval UI in the terminal and reads a single keypress
 * response (A / D / Q).  Falls back gracefully when stdin is not a TTY
 * (e.g. in CI or when piped) by defaulting to "deny" with a clear message.
 */

import readline from "readline";
import chalk from "chalk";

// ─── box drawing ─────────────────────────────────────────────────────────────

const BOX_WIDTH = 55;

function repeat(ch, n) {
  return ch.repeat(Math.max(0, n));
}

function boxTop() {
  return chalk.yellow("┌" + repeat("─", BOX_WIDTH) + "┐");
}

function boxBottom() {
  return chalk.yellow("└" + repeat("─", BOX_WIDTH) + "┘");
}

function boxDivider() {
  return chalk.yellow("├" + repeat("─", BOX_WIDTH) + "┤");
}

/**
 * Render a single row, padding content to BOX_WIDTH chars.
 * Content is plain text; caller is responsible for chalk styling.
 */
function boxRow(content) {
  // Strip ANSI escape codes for length calculation
  // eslint-disable-next-line no-control-regex
  const ansiRe = /\x1B\[[0-9;]*m/g;
  const visibleLen = content.replace(ansiRe, "").length;
  const padding = repeat(" ", Math.max(0, BOX_WIDTH - visibleLen));
  return chalk.yellow("│") + content + padding + chalk.yellow("│");
}

// ─── level colors ────────────────────────────────────────────────────────────

function colorLevel(level) {
  switch (level) {
    case "CRITICAL":
      return chalk.bgRed.white.bold(` ${level} `);
    case "HIGH":
      return chalk.red.bold(level);
    case "WARN":
      return chalk.yellow.bold(level);
    default:
      return chalk.green(level);
  }
}

function levelIcon(level) {
  switch (level) {
    case "CRITICAL":
      return "🚨";
    case "HIGH":
      return "⚠️ ";
    case "WARN":
      return "⚡";
    default:
      return "✅";
  }
}

// ─── main export ─────────────────────────────────────────────────────────────

/**
 * Display the approval prompt for a risky command and wait for user input.
 *
 * @param {import('./classifier.js').ClassifyResult} result
 * @returns {Promise<'approve'|'deny'|'quit'>}
 */
export async function promptApproval(result) {
  const { command, level, reason } = result;

  // Truncate very long commands for display
  const displayCmd =
    command.length > BOX_WIDTH - 12
      ? command.slice(0, BOX_WIDTH - 15) + "..."
      : command;

  const header = `  ${levelIcon(level)} AgentGuard \u2014 ${colorLevel(level)} RISK OPERATION`;
  const cmdLine = `  Command:  ${chalk.cyan(displayCmd)}`;
  const riskLine = `  Risk:     ${colorLevel(level)}`;
  const reasonLine = `  Reason:   ${chalk.white(reason || "unknown")}`;
  const actionLine = `  ${chalk.green("[A] Approve")}   ${chalk.red("[D] Deny")}   ${chalk.gray("[Q] Quit session")}`;

  console.error(""); // blank line before box
  console.error(boxTop());
  console.error(boxRow(header));
  console.error(boxDivider());
  console.error(boxRow(cmdLine));
  console.error(boxRow(riskLine));
  console.error(boxRow(reasonLine));
  console.error(boxDivider());
  console.error(boxRow(actionLine));
  console.error(boxBottom());
  console.error("");

  // ── non-interactive fallback ─────────────────────────────────────────────
  if (!process.stdin.isTTY) {
    console.error(
      chalk.red(
        "[AgentGuard] stdin is not a TTY — defaulting to DENY for safety.\n"
      )
    );
    return "deny";
  }

  // ── interactive readline ─────────────────────────────────────────────────
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });

    // Switch to raw mode so we get single keypresses without Enter.
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
    }

    process.stderr.write("  Choice: ");

    function onData(chunk) {
      const key = chunk.toString().toLowerCase().trim();

      if (key === "a") {
        cleanup();
        console.error(chalk.green("approve\n"));
        resolve("approve");
      } else if (key === "d") {
        cleanup();
        console.error(chalk.red("deny\n"));
        resolve("deny");
      } else if (key === "q" || key === "\u0003" /* Ctrl-C */) {
        cleanup();
        console.error(chalk.gray("quit\n"));
        resolve("quit");
      } else {
        // Re-render the prompt for unrecognized keys
        process.stderr.write("\r  Choice (a/d/q): ");
      }
    }

    function cleanup() {
      if (process.stdin.setRawMode) {
        process.stdin.setRawMode(false);
      }
      rl.close();
      process.stdin.off("data", onData);
    }

    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}
