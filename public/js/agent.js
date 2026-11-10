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
    if (prompt.length < 10) return lib().showError("Please write a more detailed prompt.");

    const btn = $("agentGenerateBtn");
    btn.disabled = true; 
    btn.textContent = "Generating files (wait ~10s)…";
    $("agentResultLog").innerHTML = ""; // clear old results
    lib().clearError();
    
    try {
      const data = await lib().api("/api/agent/generate", {
        method: "POST",
        body: JSON.stringify({ prompt })
      });

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
        code.textContent = file.content; // textContent prevents XSS
        
        pre.appendChild(code);
        div.append(title, pre);
        $("agentResultLog").append(div);
      });

      lib().showNotice("Code generated successfully! Check below.");
    } catch (e) {
      lib().showError(e.message);
    } finally {
      btn.disabled = false; 
      btn.textContent = "Generate Code";
    }
  });
})();