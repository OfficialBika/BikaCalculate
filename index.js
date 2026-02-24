require("dotenv").config();
const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const { create, all } = require("mathjs");

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN in .env");

const WEBHOOK_URL = process.env.WEBHOOK_URL; // e.g. https://xxx.up.railway.app
const PORT = parseInt(process.env.PORT || "8080", 10);

const math = create(all, { number: "number" });
const bot = new Telegraf(BOT_TOKEN);

// -------------------- Safe Eval --------------------
function safeEval(expr) {
  let s = String(expr || "").trim();
  s = s
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/—/g, "-")
    .replace(/−/g, "-")
    .replace(/,/g, "");

  // basic guard
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

// -------------------- Calculator UI (optional) --------------------
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

const state = new Map(); // chatId => { expr, result, msgId }

// -------------------- Commands --------------------
bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  const s = { expr: "", result: "", msgId: null };
  state.set(chatId, s);
  const msg = await ctx.reply(renderUI("", ""), kb());
  s.msgId = msg.message_id;
});

bot.command("calc", async (ctx) => {
  const input = ctx.message.text.replace("/calc", "").trim();
  if (!input) return ctx.reply("Usage: /calc 12*(3+4)");

  try {
    const result = safeEval(input);
    return ctx.reply(`🧮 ${input}\n= ${result}`);
  } catch (e) {
    return ctx.reply(`❌ ${e.message}`);
  }
});

// Plain text calculator
bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return;

  try {
    const result = safeEval(text);
    return ctx.reply(`🧮 ${text}\n= ${result}`);
  } catch (e) {
    return ctx.reply(`❌ ${e.message}`);
  }
});

// Button UI actions
bot.on("callback_query", async (ctx) => {
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
      await ctx.telegram.editMessageText(chatId, s.msgId, undefined, renderUI(s.expr, s.result), kb());
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

  // Show as selectable inline result
  return ctx.answerInlineQuery(
    [
      {
        type: "article",
        id: "calc_" + Date.now(),
        title: resultText.split("\n")[0], // first line as title
        description: resultText.includes("\n=") ? resultText.split("\n")[1] : resultText,
        input_message_content: { message_text: resultText },
      },
    ],
    { cache_time: 1 }
  );
});

// -------------------- ✅ Webhook Server (Railway/Render) --------------------
const app = express();

// health check + uptime ping target
app.get("/", (req, res) => res.status(200).send("OK - BIKA Calculator Bot"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

app.use(express.json());

// Webhook endpoint
app.use(await bot.createWebhook({ domain: WEBHOOK_URL, path: "/telegraf" }));
app.post("/telegraf", (req, res) => {
  // handled by telegraf webhook middleware
  res.sendStatus(200);
});

async function start() {
  if (!WEBHOOK_URL) {
    // fallback: long polling (local dev)
    await bot.launch();
    console.log("✅ Started with long polling (no WEBHOOK_URL)");
    return;
  }

  // setWebhook to your domain
  await bot.telegram.setWebhook(`${WEBHOOK_URL}/telegraf`);
  app.listen(PORT, () => console.log(`✅ Webhook server running on ${PORT}`));
}

start();

// graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
