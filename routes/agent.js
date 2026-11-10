const sql = require("../lib/db");
const { send, readBody, HttpError } = require("../lib/http");
const { audit } = require("../lib/auth");
const { rateLimitStrict } = require("../lib/ratelimit");
const { runChat } = require("../lib/ai/gateway");

// Agent needs room for several files; the plan cap (free = 800 tokens) used to cut the JSON in half.
const AGENT_MAX_OUTPUT = 3500;
const AGENT_TIMEOUT_MS = 18000;   // ek provider ke liye max
const AGENT_TOTAL_MS = 48000;     // sab providers mila ke max (Vercel limit 60s, browser 58s)

// Plain-text file blocks are far more reliable than JSON-with-HTML-inside (no escaping problems, easy to recover if cut off):
//   ===FILE: index.html===
//   <html>...</html>
//   ===END===
const buildPrompt = request => `You are a coding agent. Create the files for the request below.
Rules:
- Output ONLY file blocks, no explanations, no markdown, no backticks.
- Use exactly this format for every file:
===FILE: path/to/file.ext===
file content here
===END===
- Keep it compact (max 3 files, short code) so the answer is never cut off.

Request: ${request}`;

function stripFences(text) {
  return text.replace(/^```[a-zA-Z0-9]*\s*\n/, "").replace(/\n```\s*$/, "");
}

function parseBlocks(text) {
  const files = [];
  const re = /===FILE:\s*([^\n=]+?)\s*===\r?\n([\s\S]*?)(?:\r?\n===END===|(?=\r?\n===FILE:)|$)/g;
  let m;
  while ((m = re.exec(text))) {
    const path = m[1].trim();
    const content = stripFences(m[2]).trimEnd();
    if (path && content) files.push({ path, content });
  }
  return files;
}

function parseJsonFiles(text) {
  const start = text.indexOf("["), end = text.lastIndexOf("]");
  if (start === -1 || end === -1) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(arr) ? arr.filter(f => f && typeof f.path === "string" && typeof f.content === "string") : [];
  } catch { return []; }
}

function safePath(p) {
  return String(p).replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter(x => x && x !== "." && x !== "..").join("/").slice(0, 200);
}

function extractFiles(raw) {
  let files = parseBlocks(raw);
  if (!files.length) files = parseJsonFiles(raw);
  return files.map(f => ({ path: safePath(f.path), content: f.content })).filter(f => f.path).slice(0, 10);
}

module.exports = async function agentRoutes({ req, res, path, method, user }) {
  if (method === "POST" && path === "/api/agent/generate") {
    await rateLimitStrict(`agent:${user.id}`, 5, 60_000);
    const body = await readBody(req);

    if (!body.prompt || typeof body.prompt !== "string" || body.prompt.trim().length < 5) {
      throw new HttpError(400, "Please provide a detailed prompt.");
    }
    if (body.prompt.length > 3000) throw new HttpError(400, "Prompt is too long (max 3000 characters).");

    const projectId = body.project_id || null;
    if (projectId) {
      const p = await sql`SELECT id FROM projects WHERE id = ${projectId} AND user_id = ${user.id} AND deleted_at IS NULL LIMIT 1`;
      if (!p.length) throw new HttpError(404, "Project not found.");
    }

    // If this INSERT fails, run database/phase4-ai-agent.sql in Neon.
    let task;
    try {
      [task] = await sql`
        INSERT INTO ai_agent_tasks (user_id, project_id, prompt, status)
        VALUES (${user.id}, ${projectId}, ${body.prompt}, 'processing')
        RETURNING id`;
    } catch (e) {
      console.error("ai_agent_tasks insert failed:", e.message);
      throw new HttpError(500, "Agent table missing. Run database/phase4-ai-agent.sql in Neon SQL Editor.");
    }

    try {
      const aiResponse = await runChat(user, {
        messages: [{ role: "user", content: buildPrompt(body.prompt.trim()) }],
        mode: "platform",
        max_tokens: AGENT_MAX_OUTPUT
      }, { maxOutput: AGENT_MAX_OUTPUT, timeoutMs: AGENT_TIMEOUT_MS, deadline: Date.now() + AGENT_TOTAL_MS });

      const raw = String(aiResponse.message.content || "").trim();
      const files = extractFiles(raw);
      if (!files.length) {
        console.error("Agent: could not parse AI output:", raw.slice(0, 500));
        throw new HttpError(502, "AI did not return any files. Please try again with a shorter, simpler prompt.");
      }

      await sql`
        UPDATE ai_agent_tasks
        SET status = 'completed', result_files = ${JSON.stringify(files)}::jsonb, updated_at = NOW()
        WHERE id = ${task.id}`;
      await audit(user.id, "agent.generated", "agent_task", task.id).catch(() => {});

      return send(res, 200, { task_id: task.id, files }), true;
    } catch (error) {
      await sql`
        UPDATE ai_agent_tasks
        SET status = 'failed', error_message = ${String(error.message).slice(0, 500)}, updated_at = NOW()
        WHERE id = ${task.id}`.catch(() => {});
      if (error instanceof HttpError || error.expose) throw error;
      throw new HttpError(500, error.message || "Failed to generate code.");
    }
  }

  return false;
};
