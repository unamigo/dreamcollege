// Veer's Essay Advisor — Netlify Edge Function
// Proxies chat requests to OpenRouter so the API key never reaches the browser.
// Required Netlify environment variables:
//   OPENROUTER_API_KEY  — an OpenRouter key (set a monthly credit limit on it)
//   ADVISOR_CODE        — the access code Veer types once on the advisor page
import { CORE, METHOD, KB, SCHOOL_NAMES } from "./kb.js";

// Only these models can be called through this endpoint.
const MODELS = [
  { id: "anthropic/claude-opus-5.5",   label: "Claude Opus 5.5",   note: "Deepest thinking" },
  { id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5", note: "Fast and sharp (default)" },
  { id: "openai/gpt-6.1-sol",          label: "GPT-6.1",           note: "OpenAI" },
  { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro",  note: "Google" },
  { id: "x-ai/grok-4.7",               label: "Grok 4.7",          note: "xAI" },
];
const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";
const MAX_CHARS = 120000;     // per request, all messages combined
const MAX_MESSAGES = 60;

const env = (k) => (globalThis.Netlify && Netlify.env.get(k)) || (globalThis.Deno && Deno.env.get(k)) || "";
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function safeEqual(a, b) {
  a = String(a || ""); b = String(b || "");
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function buildSystem({ school, prompt, profile, mode, today }) {
  const parts = [CORE];
  parts.push(`\n# Today\nToday is ${today}. Keep deadlines in mind.`);
  parts.push(`\n# Coaching method guide\n${METHOD}`);
  if (school && KB[school]) {
    parts.push(`\n# Research briefing: ${SCHOOL_NAMES[school]}\nThis is the school Veer selected for this conversation. Ground your advice in it.\n\n${KB[school]}`);
  } else {
    const list = Object.keys(SCHOOL_NAMES).map((k) => SCHOOL_NAMES[k]).join(", ");
    parts.push(`\n# Scope\nVeer is working on general material (for example the Common App personal statement or activities list), not one school. His schools: ${list}. If he asks about a specific school, suggest he switch the school selector so you can load that school's research.`);
  }
  if (prompt) parts.push(`\n# The prompt he is working on\n${prompt}`);
  if (mode) parts.push(`\n# What he wants right now\n${mode}`);
  if (profile && profile.trim()) parts.push(`\n# Notes Veer wrote about himself (his own words; treat as facts about him)\n${profile.trim().slice(0, 12000)}`);
  return parts.join("\n");
}

export default async (req) => {
  if (req.method === "GET") {
    return json({
      ok: true,
      configured: !!env("OPENROUTER_API_KEY") && !!env("ADVISOR_CODE"),
      models: MODELS,
      defaultModel: DEFAULT_MODEL,
      schools: Object.keys(KB),
    });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const key = env("OPENROUTER_API_KEY");
  const code = env("ADVISOR_CODE");
  if (!key || !code) return json({ error: "The advisor is not set up yet. Ask your dad to add the OpenRouter key and access code in Netlify." }, 503);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }

  if (!safeEqual(body.code, code)) return json({ error: "That access code is not right." }, 401);
  if (body.check) return json({ ok: true });

  const model = MODELS.some((m) => m.id === body.model) ? body.model : DEFAULT_MODEL;
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const clean = msgs
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content }));
  if (!clean.length || clean[clean.length - 1].role !== "user") return json({ error: "Send a message first." }, 400);
  const total = clean.reduce((n, m) => n + m.content.length, 0);
  if (total > MAX_CHARS) return json({ error: "This conversation is too long. Start a new one (your old one is saved)." }, 413);

  const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/Chicago" });
  const system = buildSystem({
    school: typeof body.school === "string" ? body.school : "",
    prompt: typeof body.prompt === "string" ? body.prompt.slice(0, 3000) : "",
    profile: typeof body.profile === "string" ? body.profile : "",
    mode: typeof body.mode === "string" ? body.mode.slice(0, 500) : "",
    today,
  });

  // Anthropic models support prompt caching; the long system prompt is reused every turn.
  const systemMsg = model.startsWith("anthropic/")
    ? { role: "system", content: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] }
    : { role: "system", content: system };

  const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "HTTP-Referer": "https://dreamcollege.xyz/advisor/",
      "X-Title": "Veer's Essay Advisor",
    },
    body: JSON.stringify({
      model,
      stream: true,
      max_tokens: 8000,
      reasoning: { max_tokens: 2000 },
      messages: [systemMsg, ...clean],
    }),
  });

  if (!upstream.ok || !upstream.body) {
    let detail = "";
    try { detail = (await upstream.json())?.error?.message || ""; } catch {}
    return json({ error: `The model service returned an error (${upstream.status}). ${detail}`.trim() }, 502);
  }
  return new Response(upstream.body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-advisor-model": model },
  });
};

export const config = { path: "/api/advisor" };
