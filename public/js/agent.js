(() => {
  const $ = id => document.getElementById(id);
  const lib = () => window.DevNexa;

  $("agentBtn").addEventListener("click", () => {
    $("profilePanel").hidden = true; 
    $("projectDetailPanel").hidden = true; 
    $("aiPanel").hidden = true;
    $("agentPanel").hidden = false;
  });
  
  $("closeAgent").addEventListener("click", () => { 
    $("agentPanel").hidden = true; 
  });

  $("agentGenerateBtn").addEventListener("click", async () => {
    const prompt = $("agentPrompt").value.trim();
    if (prompt.length < 5) return lib().showError("Please write a prompt.");

    const btn = $("agentGenerateBtn");
    btn.disabled = true; 
    btn.textContent = "Generating... Please wait";
    $("agentResultLog").innerHTML = "<div class='muted small'>AI is thinking...</div>"; 
    lib().clearError();
    
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 58000);
    try {
      const response = await fetch("/api/agent/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${sessionStorage.getItem("devnexa_session")}`
        },
        body: JSON.stringify({ prompt }),
        signal: ctrl.signal
      });

      const textData = await response.text();
      let data;
      try {
        data = JSON.parse(textData);
      } catch (err) {
        throw new Error(`Server error (${response.status}). Try a shorter prompt. ${textData.slice(0, 80)}`);
      }

      if (!response.ok) {
        throw new Error(data.error || "Server error occurred");
      }

      if (!data.files || data.files.length === 0) {
        throw new Error("AI returned empty files.");
      }

      // Output render karein
      $("agentResultLog").innerHTML = "";
      data.files.forEach(file => {
        const div = document.createElement("div");
        div.className = "ai-msg assistant";
        
        const title = document.createElement("strong");
        title.textContent = file.path;
        
        const pre = document.createElement("pre");
        pre.style.overflowX = "auto";
        pre.style.fontSize = "11px";
        pre.style.marginTop = "5px";
        
        const code = document.createElement("code");
        code.textContent = file.content; 
        
        pre.appendChild(code);
        div.append(title, pre);
        $("agentResultLog").append(div);
      });

      lib().showNotice("Code generated successfully!");
    } catch (e) {
      lib().showError(e.name === "AbortError" ? "Request timed out. Try a shorter prompt." : e.message);
      $("agentResultLog").innerHTML = ""; 
    } finally {
      clearTimeout(timer);
      btn.disabled = false; 
      btn.textContent = "Generate Code";
    }
  });
})();