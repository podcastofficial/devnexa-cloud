const sql = require("../lib/db");
const { send, readBody, HttpError } = require("../lib/http");
const { audit } = require("../lib/auth");
const { rateLimitStrict } = require("../lib/ratelimit");
const { runChat } = require("../lib/ai/gateway");

module.exports = async function agentRoutes({ req, res, path, method, user }) {
  if (method === "POST" && path === "/api/agent/generate") {
    await rateLimitStrict(`agent:${user.id}`, 5, 60_000); // Max 5 requests per minute
    const body = await readBody(req);
    
    if (!body.prompt || typeof body.prompt !== "string" || body.prompt.length < 10) {
      throw new HttpError(400, "Please provide a detailed prompt (at least 10 characters).");
    }

    const projectId = body.project_id || null;
    if (projectId) {
      const p = await sql`SELECT id FROM projects WHERE id = ${projectId} AND user_id = ${user.id} AND deleted_at IS NULL LIMIT 1`;
      if (!p.length) throw new HttpError(404, "Project not found.");
    }

    // 1. Create task in DB
    const [task] = await sql`
      INSERT INTO ai_agent_tasks (user_id, project_id, prompt, status)
      VALUES (${user.id}, ${projectId}, ${body.prompt}, 'processing')
      RETURNING id`;

    try {
      // 2. Instruct AI to return strict JSON
      const systemPrompt = `You are an expert full-stack developer. The user will give you a prompt. 
You must generate the code files and return ONLY a valid JSON array. 
Do not include markdown formatting, do not use \`\`\`json, just output the raw JSON array.
Format: [{"path": "index.html", "content": "<html>...</html>"}, {"path": "style.css", "content": "body { ... }"}]
User request: ${body.prompt}`;

      const aiResponse = await runChat(user, {
        messages: [{ role: "user", content: systemPrompt }],
        mode: "platform"
      });

      let rawText = aiResponse.message.content;
      // Cleanup in case AI still adds markdown
      rawText = rawText.replace(/```json/g, "").replace(/```/g, "").trim();
      
      let files = [];
      try {
        files = JSON.parse(rawText);
        if (!Array.isArray(files)) throw new Error("Not an array");
      } catch (e) {
        throw new Error("AI returned invalid format. Please try again.");
      }

      // 3. Update task in DB
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