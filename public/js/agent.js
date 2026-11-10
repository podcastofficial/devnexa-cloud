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
    
    try {
      // Timeout set kiya taaki request atak na jaye
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000); // 25 seconds timeout

      const response = await fetch("/api/agent/generate", {
        method: "POST",
        headers: { 
            "Content-Type": "application/json",
            "Authorization": `Bearer ${sessionStorage.getItem("devnexa_session")}`
        },
        body: JSON.stringify({ prompt }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Server error occurred");
      }

      if (!data.files || data.files.length === 0) {
        throw new Error("AI returned empty files.");
      }

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
      if (e.name === 'AbortError') {
        lib().showError("Request timed out. The AI is taking too long (Vercel 10s limit). Please try a shorter prompt.");
      } else {
        lib().showError(e.message);
      }
      $("agentResultLog").innerHTML = ""; 
    } finally {
      btn.disabled = false; 
      btn.textContent = "Generate Code";
    }
  });
})();