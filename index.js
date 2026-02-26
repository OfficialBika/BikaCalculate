require("dotenv").config();
const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const { create, all } = require("mathjs");

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN in .env");

const WEBHOOK_URL = process.env.WEBHOOK_URL; // e.g. https://xxx.onrender.com
const PORT = parseInt(process.env.PORT || "8080", 10);
const OWNER_ID = Number(process.env.OWNER_ID || 0);

const math = create(all, { number: "number" });
const bot = new Telegraf(BOT_TOKEN);

// Stats + state
const startTime = Date.now();
const users = new Set();             // user ids
const groups = new Map();            // chatId -> { title, type }
const adminCache = new Map();        // chatId -> boolean (bot is admin or not)
const state = new Map();             // chatId -> { expr, result, msgId }

// -------------------- Helper: Safe Eval --------------------
function safeEval(expr) {
  let s = String(expr || "").trim();
  s = s
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/—/g, "-")
    .replace(/−/g, "-")
    .replace(/,/g, "");

  const blocked = /(import|createUnit|evaluate|parse|simplify|derivative|compile|help|unit|format|typed|reviver|json|chain|matrix|ones|zeros|range|index|subset|concat|resize)/i;
  if (blocked.test(s)) throw new Error("Unsupported expression.");

  const allowed = /^[0-9+\-*/().\s^%piePIE]*$/;
  if (!allowed.test(s)) throw new Error("Invalid characters.");

  const result = math.evaluate(s);

  if (typeof result === "number") {
    if (!isFinite(result)) throw new Error("Result is not finite.");
    const rounded = Math.round((result + Number.EPSILON) * 1e12) / 1e12;
    return String(rounded);
  }
  return String(result);
}

// -------------------- Helper: Keyboard + UI --------------------
function kb() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("7", "k:7"),
      Markup.button.callback("8", "k:8"),
      Markup.button.callback("9", "k:9"),
      Markup.button.callback("÷", "k:/"),
    ],
    [
      Markup.button.callback("4", "k:4"),
      Markup.button.callback("5", "k:5"),
      Markup.button.callback("6", "k:6"),
      Markup.button.callback("×", "k:*"),
    ],
    [
      Markup.button.callback("1", "k:1"),
      Markup.button.callback("2", "k:2"),
      Markup.button.callback("3", "k:3"),
      Markup.button.callback("-", "k:-"),
    ],
    [
      Markup.button.callback("0", "k:0"),
      Markup.button.callback(".", "k:."),
      Markup.button.callback("(", "k:("),
      Markup.button.callback(")", "k:)"),
    ],
    [
      Markup.button.callback("C", "k:C"),
      Markup.button.callback("⌫", "k:BS"),
      Markup.button.callback("+", "k:+"),
      Markup.button.callback("=", "k:="),
    ],
  ]);
}

function renderUI(expr, result) {
  const e = expr?.length ? expr : " ";
  const r = result?.length ? result : " ";
  return `🧮 BIKA Calculator\n\nExpr: ${e}\nResult: ${r}\n\nTip: Inline → @YourBot 12*(3+4)`;
}

// -------------------- Helper: Track users/groups --------------------
function trackContext(ctx) {
  try {
    if (ctx.from && ctx.from.id) {
      users.add(ctx.from.id);
    }
    if (ctx.chat && (ctx.chat.type === "group" || ctx.chat.type === "supergroup")) {
      groups.set(ctx.chat.id, {
        title: ctx.chat.title || "",
        type: ctx.chat.type,
      });
    }
  } catch (_) {
    // ignore tracking errors
  }
}

// -------------------- Helper: Bot admin in group? --------------------
async function isBotAdminInChat(ctx) {
  const chat = ctx.chat;
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return false;

  const chatId = chat.id;
  if (adminCache.has(chatId)) {
    return adminCache.get(chatId);
  }

  try {
    const me = await ctx.telegram.getChatMember(chatId, ctx.botInfo.id);
    const isAdmin =
      me.status === "administrator" || me.status === "creator";
    adminCache.set(chatId, isAdmin);
    return isAdmin;
  } catch (err) {
    console.error("getChatMember failed:", err.message);
    adminCache.set(chatId, false);
    return false;
  }
}

// -------------------- Helper: Uptime format --------------------
function formatUptime(ms) {
  let sec = Math.floor(ms / 1000);
  const days = Math.floor(sec / 86400); sec %= 86400;
  const hours = Math.floor(sec / 3600); sec %= 3600;
  const mins = Math.floor(sec / 60); sec %= 60;

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins) parts.push(`${mins}m`);
  parts.push(`${sec}s`);
  return parts.join(" ");
}

// -------------------- Commands --------------------
bot.start(async (ctx) => {
  trackContext(ctx);

  const chatId = ctx.chat.id;
  const s = { expr: "", result: "", msgId: null };
  state.set(chatId, s);

  const msg = await ctx.reply(renderUI("", ""), kb());
  s.msgId = msg.message_id;
});

bot.command("calc", async (ctx) => {
  trackContext(ctx);
  const input = ctx.message.text.replace("/calc", "").trim();
  if (!input) return ctx.reply("Usage: /calc 12*(3+4)");

  try {
    const result = safeEval(input);
    return ctx.reply(`🧮 ${input}\n= ${result}`);
  } catch (e) {
    return ctx.reply(`❌ ${e.message}`);
  }
});

// Owner-only admin dashboard
bot.command("admin", async (ctx) => {
  trackContext(ctx);
  if (!OWNER_ID || ctx.from.id !== OWNER_ID) {
    return ctx.reply("❌ Owner only command.");
  }

  const totalUsers = users.size;
  const totalGroups = groups.size;
  const uptimeMs = Date.now() - startTime;
  const uptimeStr = formatUptime(uptimeMs);

  let groupList = "";
  let index = 1;
  for (const [chatId, info] of groups.entries()) {
    if (index > 30) {
      groupList += `\n… and more (${totalGroups} groups total)`;
      break;
    }
    groupList += `\n${index}. ${info.title || "(no title)"} [${chatId}]`;
    index++;
  }

  const text =
    `🔐 BIKA Calculator — Admin Dashboard\n\n` +
    `👤 Bot Users: ${totalUsers}\n` +
    `👥 Total Groups: ${totalGroups}\n` +
    `⏱ Uptime: ${uptimeStr}\n` +
    `${totalGroups ? "\n📜 Group List:" + groupList : ""}`;

  return ctx.reply(text);
});

// Owner-only broadcast
bot.command("broadcast", async (ctx) => {
  trackContext(ctx);
  if (!OWNER_ID || ctx.from.id !== OWNER_ID) {
    return ctx.reply("❌ Owner only command.");
  }

  const args = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!args) {
    return ctx.reply("Usage: /broadcast Your message here");
  }

  const msg = `📢 [BIKA Calculator Broadcast]\n\n${args}`;
  let userOk = 0, userFail = 0;
  let groupOk = 0, groupFail = 0;

  // send to users
  for (const userId of users) {
    try {
      await ctx.telegram.sendMessage(userId, msg);
      userOk++;
    } catch (_) {
      userFail++;
    }
  }

  // send to groups
  for (const [chatId] of groups.entries()) {
    try {
      await ctx.telegram.sendMessage(chatId, msg);
      groupOk++;
    } catch (_) {
      groupFail++;
    }
  }

  return ctx.reply(
    `✅ Broadcast finished.\n\n` +
    `👤 Users: ${userOk} sent, ${userFail} failed.\n` +
    `👥 Groups: ${groupOk} sent, ${groupFail} failed.`
  );
});

// -------------------- Plain text calculator --------------------
bot.on("text", async (ctx) => {
  trackContext(ctx);

  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return; // commands handled separately

  // GROUP MODE: auto calc only when bot is admin
  if (ctx.chat.type === "group" || ctx.chat.type === "supergroup") {
    const isAdmin = await isBotAdminInChat(ctx);
    if (!isAdmin) return;

    try {
      const result = safeEval(text);
      // pretty: replace * with ×, / with ÷ in expression only
      const prettyExpr = text.replace(/\*/g, "×").replace(/\//g, "÷");
      return ctx.reply(`${prettyExpr} = ${result}`);
    } catch (_) {
      // not a valid expression -> ignore in group
      return;
    }
  }

  // PRIVATE CHAT: normal calculator with error messages
  if (ctx.chat.type === "private") {
    try {
      const result = safeEval(text);
      return ctx.reply(`🧮 ${text}\n= ${result}`);
    } catch (e) {
      return ctx.reply(`❌ ${e.message}`);
    }
  }
});

// -------------------- Button UI actions --------------------
bot.on("callback_query", async (ctx) => {
  trackContext(ctx);

  const chatId = ctx.chat.id;
  const data = ctx.callbackQuery.data || "";
  const s = state.get(chatId) || { expr: "", result: "", msgId: null };
  state.set(chatId, s);

  if (!data.startsWith("k:")) return ctx.answerCbQuery();
  const key = data.slice(2);

  if (key === "C") {
    s.expr = "";
    s.result = "";
  } else if (key === "BS") {
    s.expr = s.expr.slice(0, -1);
  } else if (key === "=") {
    try {
      s.result = s.expr ? safeEval(s.expr) : "";
    } catch (e) {
      s.result = `Error: ${e.message}`;
    }
  } else {
    s.expr += key;
  }

  try {
    if (s.msgId) {
      await ctx.telegram.editMessageText(
        chatId,
        s.msgId,
        undefined,
        renderUI(s.expr, s.result),
        kb()
      );
    } else {
      const msg = await ctx.reply(renderUI(s.expr, s.result), kb());
      s.msgId = msg.message_id;
    }
  } catch (_) {
    const msg = await ctx.reply(renderUI(s.expr, s.result), kb());
    s.msgId = msg.message_id;
  }

  return ctx.answerCbQuery();
});

// -------------------- ✅ Inline Mode --------------------
// Enable in BotFather: /setinline -> choose your bot -> Turn ON
bot.on("inline_query", async (ctx) => {
  const q = (ctx.inlineQuery.query || "").trim();

  // If empty query, show hint
  if (!q) {
    return ctx.answerInlineQuery(
      [
        {
          type: "article",
          id: "hint",
          title: "Type an expression like: 1+2 or 12*(3+4)",
          input_message_content: { message_text: "🧮 Try: 12*(3+4)" },
          description: "Calculator inline mode",
        },
      ],
      { cache_time: 1 }
    );
  }

  let resultText;
  try {
    const r = safeEval(q);
    resultText = `🧮 ${q}\n= ${r}`;
  } catch (e) {
    resultText = `❌ ${q}\n${e.message}`;
  }

  return ctx.answerInlineQuery(
    [
      {
        type: "article",
        id: "calc_" + Date.now(),
        title: resultText.split("\n")[0],
        description: resultText.includes("\n=")
          ? resultText.split("\n")[1]
          : resultText,
        input_message_content: { message_text: resultText },
      },
    ],
    { cache_time: 1 }
  );
});

// -------------------- ✅ Webhook Server (Render) --------------------
const app = express();

// health check + uptime ping target
app.get("/", (req, res) => res.status(200).send("OK - BIKA Calculator Bot"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

app.use(express.json());

// Telegraf webhook middleware
app.use("/telegraf", bot.webhookCallback("/telegraf"));

async function start() {
  try {
    // Make sure botInfo is available (for getChatMember)
    const me = await bot.telegram.getMe();
    bot.botInfo = me;
    console.log(`🤖 Logged in as @${me.username}`);

    if (!WEBHOOK_URL) {
      await bot.launch();
      console.log("✅ Started with long polling (no WEBHOOK_URL)");
    } else {
      await bot.telegram.setWebhook(`${WEBHOOK_URL}/telegraf`);
      app.listen(PORT, () =>
        console.log(`✅ Webhook server running on ${PORT}`)
      );
    }
  } catch (err) {
    console.error("❌ Failed to start bot:", err);
  }
}

start();

// graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
