const axios = require('axios');

// ENV VARS — set these in Vercel dashboard
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// ------------- CHUNKING UTILS ------------------
function chunkText(text, max = 6000) {
  const sentences = text.split(/(?<=[.!?])\s+/);
  let chunks = [];
  let current = "";
  
  for (const s of sentences) {
    if ((current + s).length > max) {
      if (current.trim().length > 0) {
        chunks.push(current.trim());
      }
      current = "";
    }
    current += s + " ";
  }
  
  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }
  
  return chunks;
}

// ------------- GPT CALL ------------------------
async function callGPT(system, user) {
  const url = "https://api.openai.com/v1/chat/completions"; // FIXED: Correct endpoint
  
  try {
    const { data } = await axios.post(
      url,
      {
        model: "gpt-4-turbo-preview",
        messages: [ // FIXED: Correct format
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        temperature: 0.3,
        max_tokens: 7000 // FIXED: Correct parameter name
      },
      {
        headers: { 
          "Authorization": `Bearer ${OPENAI_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );
    
    return data.choices[0].message.content;
  } catch (error) {
    console.error("GPT Error:", error.response?.data || error.message);
    throw new Error(`GPT call failed: ${error.response?.data?.error?.message || error.message}`);
  }
}

// ------------- CLAUDE CALL ----------------------
async function callClaude(system, user) {
  const url = "https://api.anthropic.com/v1/messages";
  
  try {
    const { data } = await axios.post(
      url,
      {
        model: "claude-sonnet-4-20250514", // FIXED: Latest model
        max_tokens: 16000, // FIXED: Increased for comprehensive output
        system: system,
        messages: [{ role: "user", content: user }]
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        }
      }
    );
    
    return data.content[0].text;
  } catch (error) {
    console.error("Claude Error:", error.response?.data || error.message);
    throw new Error(`Claude call failed: ${error.response?.data?.error?.message || error.message}`);
  }
}

// ------------- MAIN ORCHESTRATOR ---------------
module.exports = async (req, res) => { // FIXED: CommonJS export for Vercel
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { source_wp, merged_text } = req.body;

    // Validation
    if (!source_wp) {
      return res.status(400).json({ error: "source_wp is required" });
    }

    if (!OPENAI_KEY || !ANTHROPIC_KEY) {
      return res.status(500).json({ error: "API keys not configured" });
    }

    const doc = merged_text || "";
    const chunks = doc.length > 10000 ? chunkText(doc) : [doc];

    console.log(`Processing ${chunks.length} chunks...`);

    // 1) PROCESS ALL CHUNKS THROUGH GPT
    let processedChunks = [];
    for (let i = 0; i < chunks.length; i++) {
      console.log(`Processing chunk ${i + 1}/${chunks.length}`);
      
      const system = "You are a document preparation engine. Clean, structure, and clarify this section. Keep all content. Do not summarize.";
      const user = chunks[i];
      
      const result = await callGPT(system, user);
      processedChunks.push(result);
    }

    const merged = processedChunks.join("\n\n---\n\n");
    console.log("All chunks processed and merged");

    // 2) SEND MERGED TO GPT FOR MAIN GENERATION
    const systemMain = `You are an expert audit planner. Generate the full audit working program based on user input and document content. Use latest IIA & ISO 19011 standards. 

Output structured HTML suitable for web display:
- Use <h1> for main title, <h2> for sections, <h3> for subsections
- Use <p> for paragraphs
- Use <ul>/<ol> for lists
- Use <table> with <thead> and <tbody> for tabular data
- Keep professional, clear, and human-like tone
- Maintain all content - no summarization
- NO CSS or style attributes
- Use semantic HTML only`;

    const userMain = `# USER INPUT
${source_wp}

# PROCESSED DOCUMENT CONTENT
${merged}

Generate the complete Audit Working Program in clean, semantic HTML. Structure it professionally with clear sections. No CSS.`;

    console.log("Generating GPT draft...");
    const gptDraft = await callGPT(systemMain, userMain);

    // 3) CLAUDE FINAL REVIEW
    const claudeSystem = `You are a senior audit reviewer with expertise in IIA Standards and ISO 19011. 

Your task: Review and enhance the GPT-generated audit working program draft.

Check for:
- Correctness and accuracy
- Clarity and professional presentation
- Completeness (no missing elements)
- Consistency with IIA & ISO 19011 standards
- Proper structure and flow
- Technical precision

Output requirements:
- Ready-to-use clean HTML (semantic tags only)
- NO CSS or inline styles
- Maintain all details from the draft
- Enhance structure and clarity where needed
- Professional audit documentation tone
- Do NOT summarize or remove content

Deliver production-ready HTML suitable for direct web display.`;

    const claudeUser = `# ORIGINAL USER REQUIREMENTS
${source_wp}

# GPT DRAFT TO REVIEW
${gptDraft}

Review this draft and provide the final, enhanced version in clean HTML. Fix any issues, improve clarity, ensure compliance with standards, but keep all substantive content.`;

    console.log("Sending to Claude for final review...");
    const finalOutput = await callClaude(claudeSystem, claudeUser);

    console.log("Process complete!");

    return res.status(200).json({
      success: true,
      ai_output: finalOutput,
      ai_draft: gptDraft,
      chunks_used: chunks.length,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error("Orchestrator Error:", err);
    
    return res.status(500).json({ 
      error: "Internal processing error", 
      details: err.message,
      timestamp: new Date().toISOString()
    });
  }
};
