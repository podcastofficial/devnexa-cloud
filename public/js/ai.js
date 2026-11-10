(() => {
  const $ = id => document.getElementById(id);
  const NAMES = { openai: "OpenAI", anthropic: "Anthropic", groq: "Groq", gemini: "Google Gemini", openrouter: "OpenRouter" };
  let status = null;
  let history = []; // [{role, content}] kept in memory only
  const lib = () => window.DevNexa;

  function addMsg(role, text, meta) {
    const d = document.createElement("div");
    d.className = `ai-msg ${role}`;
    d.textContent = text; // textContent: model output is untrusted, never innerHTML
    if (meta) { const s = document.createElement("small"); s.textContent = meta; d.append(s); }
    $("aiChatLog").append(d);
    $("aiChatLog").scrollTop = $("aiChatLog").scrollHeight;
  }

  function renderStatus() {
    const q = status.quota;
    $("aiQuota").textContent = `Free allowance (${q.plan}): ${q.day_requests.used}/${q.day_requests.limit} requests today · ${q.month_tokens.used.toLocaleString()}/${q.month_tokens.limit.toLocaleString()} tokens this month`;
    const mode = $("aiMode");
    const prev = mode.value;
    mode.innerHTML = "";
    if (status.platform.available) mode.append(new Option("Free models (limited)", "platform"));
    status.keys.forEach(k => mode.append(new Option(`My ${NAMES[k.provider] || k.provider} key (…${k.key_last4})`, `byok:${k.provider}`)));
    if (!mode.options.length) mode.append(new Option("No AI available — add your own key below", ""));
    if ([...mode.options].some(o => o.value === prev)) mode.value = prev;

    const sel = $("aiKeyProvider");
    if (!sel.options.length) status.byok_providers.forEach(p => sel.append(new Option(NAMES[p] || p, p)));

    const list = $("aiKeyList");
    list.innerHTML = "";
    status.keys.forEach(k => {
      const row = document.createElement("div");
      row.className = "provider-row";
      const label = document.createElement("span");
      label.textContent = `${NAMES[k.provider] || k.provider} · …${k.key_last4}`;
      const rm = document.createElement("button");
      rm.className = "text-btn"; rm.type = "button"; rm.textContent = "Remove";
      rm.addEventListener("click", async () => {
        try { await lib().api("/api/ai/keys/remove", { method: "POST", body: JSON.stringify({ provider: k.provider }) }); await load(); }
        catch (e) { lib().showError(e.message); }
      });
      row.append(label, rm);
      list.append(row);
    });
  }

  async function load() {
    try { status = await lib().api("/api/ai/status"); renderStatus(); }
    catch (e) { lib().showError(e.message); }
  }

  $("aiBtn").addEventListener("click", () => {
    $("profilePanel").hidden = true; $("projectDetailPanel").hidden = true;
    $("aiPanel").hidden = false;
    load();
  });
  $("closeAi").addEventListener("click", () => { $("aiPanel").hidden = true; });

  $("aiKeySaveBtn").addEventListener("click", async () => {
    const btn = $("aiKeySaveBtn"), input = $("aiKeyInput");
    btn.disabled = true;
    try {
      await lib().api("/api/ai/keys", { method: "POST", body: JSON.stringify({ provider: $("aiKeyProvider").value, api_key: input.value.trim() }) });
      input.value = "";
      lib().showNotice("API key verified and saved securely.");
      await load();
    } catch (e) { lib().showError(e.message); }
    finally { btn.disabled = false; }
  });

  $("aiSendBtn").addEventListener("click", async () => {
    const text = $("aiInput").value.trim();
    const modeVal = $("aiMode").value;
    if (!text) return;
    if (!modeVal) return lib().showError("Add your own API key to use AI right now.");
    const btn = $("aiSendBtn");
    btn.disabled = true; btn.textContent = "Thinking…";
    const body = modeVal.startsWith("byok:") ? { mode: "byok", provider: modeVal.slice(5) } : { mode: "platform" };
    const next = [...history, { role: "user", content: text }];
    addMsg("user", text); $("aiInput").value = "";
    try {
      const r = await lib().api("/api/ai/chat", { method: "POST", body: JSON.stringify({ ...body, messages: next.slice(-12) }) });
      history = [...next, r.message];
      addMsg("assistant", r.message.content, `${NAMES[r.provider] || r.provider} · ${r.model}${r.fallback_used ? " · fallback" : ""} · ${r.usage.input + r.usage.output} tokens`);
      load();
    } catch (e) { history = next.slice(0, -1); lib().showError(e.message); }
    finally { btn.disabled = false; btn.textContent = "Send"; }
  });
})();
