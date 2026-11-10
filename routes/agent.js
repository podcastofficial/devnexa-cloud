const sql = require("../lib/db");
const { send, readBody, HttpError } = require("../lib/http");
const { audit } = require("../lib/auth");
const { rateLimitStrict } = require("../lib/ratelimit");
const { runChat } = require("../lib/ai/gateway");

module.exports = async function agentRoutes({ req, res, path, method, user }) {
  if (method === "POST" && path === "/api/agent/generate") {
    await rateLimitStrict(`agent:${user.id}`, 5, 60_000);
    const body = await readBody(req);
    
    if (!body.prompt || typeof body.prompt !== "string" || body.prompt.length < 10) {
      throw new HttpError(400, "Please provide a detailed prompt (at least 10 characters).");
    }

    const projectId = body.project_id || null;
    if (projectId) {
      const p = await sql`SELECT id FROM projects WHERE id = ${projectId} AND user_id = ${user.id} AND deleted_at IS NULL LIMIT 1`;
      if (!p.length) throw new HttpError(404, "Project not found.");
    }

    const [task] = await sql`
      INSERT INTO ai_agent_tasks (user_id, project_id, prompt, status)
      VALUES (${user.id}, ${projectId}, ${body.prompt}, 'processing')
      RETURNING id`;

    try {
      // Strict system prompt
      const systemPrompt = `You are a machine that ONLY outputs raw JSON. Do NOT output any text, markdown formatting, or backticks. 
Output format must be exactly like this:
[
  {"path": "index.html", "content": "<html>...</html>"},
  {"path": "style.css", "content": "body { ... }"}
]
Generate the files for this request: ${body.prompt}`;

      // max_tokens badha diya taaki code cut na ho
      const aiResponse = await runChat(user, {
        messages: [{ role: "user", content: systemPrompt }],
        mode: "platform",
        max_tokens: 3500 
      });

      let rawText = aiResponse.message.content.trim();
      
      // Extra cleanup just in case AI ne markdown lagaya ho
      rawText = rawText.replace(/```json/g, "").replace(/```/g, "").trim();
      
      // Agar AI ne pehle koi text likha hai, toh sirf JSON array nikalne ki koshish karein
      const startIdx = rawText.indexOf('[');
      const endIdx = rawText.lastIndexOf(']');
      if (startIdx !== -1 && endIdx !== -1) {
        rawText = rawText.substring(startIdx, endIdx + 1);
      }

      let files = [];
      try {
        files = JSON.parse(rawText);
        if (!Array.isArray(files)) throw new Error("Not an array");
      } catch (e) {
        console.error("AI raw response was:", rawText);
        throw new Error("AI returned an invalid format. Please try a shorter prompt.");
      }

      await sql`
        UPDATE ai_agent_tasks 
        SET status = 'completed', result_files = ${JSON.stringify(files)}::jsonb, updated_at = NOW()
        WHERE id = ${task.id}`;
        
      await audit(user.id, "agent.generated", "agent_task", task.id);

      return send(res, 200, { task_id: task.id, files }), true;

    } catch (error) {
      await sql`
        UPDATE ai_agent_tasks 
        SET status = 'failed', error_message = ${error.message}, updated_at = NOW()
        WHERE id = ${task.id}`;
      throw new HttpError(500, error.message || "Failed to generate code.");
    }
  }

  return false;
};