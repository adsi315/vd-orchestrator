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
async function callGPT(system, user, maxTokens = 4000) {
  const url = "https://api.openai.com/v1/chat/completions";
  
  try {
    const { data } = await axios.post(
      url,
      {
        model: "gpt-4-turbo-preview",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        temperature: 0.3,
        max_tokens: maxTokens // Made this a parameter
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
        model: "claude-sonnet-4-20250514",
        max_tokens: 16000,
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
module.exports = async (req, res) => {
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
    const chunks = doc.length > 10000 ? chunkText(doc, 8000) : [doc]; // Increased chunk size

    console.log(`Processing ${chunks.length} chunks...`);

    // 1) PROCESS ALL CHUNKS THROUGH GPT
    let processedChunks = [];
    for (let i = 0; i < chunks.length; i++) {
      console.log(`Processing chunk ${i + 1}/${chunks.length}`);
      
      const system = "You are a document preparation engine. Clean, structure, and clarify this section. Keep all content. Do not summarize.";
      const user = chunks[i];
      
      // Use 3000 tokens for chunk processing (shorter outputs)
      const result = await callGPT(system, user, 3000);
      processedChunks.push(result);
      
      // Small delay to avoid rate limits
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    const merged = processedChunks.join("\n\n---\n\n");
    console.log("All chunks processed and merged");

    // 2) SEND MERGED TO GPT FOR MAIN GENERATION
    const systemMain = `You are an expert audit planner specializing in internal audit and quality management systems. Generate comprehensive audit working programs based on user requirements and document content. Apply latest IIA Standards and ISO 19011:2018 guidelines.

Output Requirements:
- Structure: Use HTML semantic tags (<h1>, <h2>, <h3>, <p>, <ul>, <ol>, <table>)
- No CSS or inline styles
- Professional audit documentation tone
- Clear, actionable content
- Maintain all substantive information
- Include audit objectives, scope, procedures, criteria, resources, and timelines where applicable`;

    const userMain = `# USER REQUIREMENTS
${source_wp}

# DOCUMENT CONTENT (Processed)
${merged.substring(0, 25000)} 

Generate a complete, professional Audit Working Program in clean HTML format. Structure it with clear sections covering all essential audit program elements.`;

    console.log("Generating GPT draft...");
    const gptDraft = await callGPT(systemMain, userMain, 4000); // Max allowed tokens

    // 3) CLAUDE FINAL REVIEW
    const claudeSystem = `You are a senior audit reviewer and quality assurance specialist with deep expertise in IIA International Standards for the Professional Practice of Internal Auditing and ISO 19011:2018 Guidelines for auditing management systems.

Your mission: Conduct a comprehensive review and enhancement of the audit working program draft.

Review Criteria:
✓ Technical Accuracy - Verify alignment with IIA Standards and ISO 19011
✓ Completeness - Ensure all critical audit program elements are present
✓ Clarity - Check for clear, unambiguous language
✓ Structure - Assess logical flow and organization
✓ Professionalism - Maintain audit documentation standards
✓ Practicality - Ensure procedures are implementable

Output Requirements:
- Clean HTML with semantic tags only (no CSS)
- Enhanced structure and clarity
- All substantive content preserved and improved
- Professional audit documentation tone
- Production-ready for immediate use
- Must include: objectives, scope, criteria, methodology, resources, timeline, reporting structure

Do not summarize or remove content - enhance and refine it.`;

    const claudeUser = `# ORIGINAL USER REQUIREMENTS
${source_wp}

# GPT DRAFT TO REVIEW AND ENHANCE
${gptDraft}

Conduct your comprehensive review and provide the final, production-ready audit working program in clean HTML. Enhance structure, fix any gaps, ensure compliance with standards, and deliver a professional document ready for immediate deployment.`;

    console.log("Sending to Claude for final review...");
    const finalOutput = await callClaude(claudeSystem, claudeUser);

    console.log("Process complete!");

    return res.status(200).json({
      success: true,
      ai_output: finalOutput,
      ai_draft: gptDraft,
      chunks_processed: chunks.length,
      timestamp: new Date().toISOString(),
      metadata: {
        original_doc_length: doc.length,
        processed_chunks: processedChunks.length,
        model_used: {
          processing: "gpt-4-turbo-preview",
          review: "claude-sonnet-4-20250514"
        }
      }
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
