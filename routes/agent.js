const sql = require("../lib/db");
const { send, readBody, HttpError } = require("../lib/http");
const { audit } = require("../lib/auth");
const { rateLimitStrict } = require("../lib/ratelimit");
const { runChat } = require("../lib/ai/gateway");

module.exports = async function agentRoutes({ req, res, path, method, user }) {
  if (method === "POST" && path === "/api/agent/generate") {
    await rateLimitStrict(`agent:${user.id}`, 5, 60_000);
    const body = await readBody(req);
    
    if (!body.prompt || typeof body.prompt !== "string" || body.prompt.length < 5) {
      throw new HttpError(400, "Please provide a detailed prompt.");
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
      const systemPrompt = `You are a machine that ONLY outputs raw JSON. Do NOT output any text, markdown formatting, or backticks. 
Output format must be exactly like this:
[
  {"path": "index.html", "content": "<html>...</html>"}
]
Generate the files for this request: ${body.prompt}`;

      // AI Call
      const aiResponse = await runChat(user, {
        messages: [{ role: "user", content: systemPrompt }],
        mode: "platform",
        max_tokens: 1500
      });

      let rawText = aiResponse.message.content.trim();
      
      // Extract JSON array safely
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
        console.error("AI Format Error:", rawText); // Vercel logs ke liye
        throw new Error("AI generated invalid format. Please try again.");
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
      
      // Yahan hum asli error bhej rahe hain frontend ko
      throw new HttpError(500, error.message || "Failed to generate code.");
    }
  }

  return false;
};