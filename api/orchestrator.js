const axios = require('axios');

// ENV VARS
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// ------------- CHUNKING UTILS ------------------
function chunkText(text, max = 8000) {
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
    console.log('Calling GPT...');
    
    const { data } = await axios.post(
      url,
      {
        model: "gpt-4-turbo-preview",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        temperature: 0.3,
        max_tokens: maxTokens
      },
      {
        headers: { 
          "Authorization": `Bearer ${OPENAI_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );
    
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      throw new Error('Invalid GPT response structure');
    }
    
    return data.choices[0].message.content;
    
  } catch (error) {
    console.error("GPT Error:", error.response?.data || error.message);
    throw new Error(`GPT: ${error.response?.data?.error?.message || error.message}`);
  }
}

// ------------- CLAUDE CALL ----------------------
async function callClaude(system, user) {
  const url = "https://api.anthropic.com/v1/messages";
  
  try {
    console.log('Calling Claude...');
    
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
    
    if (!data.content || !data.content[0] || !data.content[0].text) {
      throw new Error('Invalid Claude response structure');
    }
    
    return data.content[0].text;
    
  } catch (error) {
    console.error("Claude Error:", error.response?.data || error.message);
    throw new Error(`Claude: ${error.response?.data?.error?.message || error.message}`);
  }
}

// ------------- MAIN ORCHESTRATOR ---------------
module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Health check
  if (req.method === 'GET' && !req.query.source_wp) {
    return res.status(200).json({
      status: 'ok',
      message: 'Orchestrator API is running',
      usage: 'POST or GET with parameters: source_wp (required), merged_text (optional)',
      example: '/api/orchestrator?source_wp=your_text&merged_text=your_doc',
      env_check: {
        openai_key: !!OPENAI_KEY,
        anthropic_key: !!ANTHROPIC_KEY
      }
    });
  }

  // Accept both POST and GET methods
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ 
      error: 'Method not allowed',
      allowed_methods: ['POST', 'GET']
    });
  }

  try {
    // PRIORITY 1: Get parameters from query string (most reliable with Bubble)
    let source_wp = req.query.source_wp || '';
    let merged_text = req.query.merged_text || '';

    // PRIORITY 2: Try to get from body if query params are empty
    if (!source_wp && req.body) {
      console.log('No query params, checking body...');
      console.log('Body type:', typeof req.body);
      
      if (typeof req.body === 'object' && req.body.source_wp) {
        source_wp = req.body.source_wp;
        merged_text = req.body.merged_text || '';
        console.log('Got params from parsed body object');
      } else if (typeof req.body === 'string') {
        try {
          const parsed = JSON.parse(req.body);
          source_wp = parsed.source_wp || '';
          merged_text = parsed.merged_text || '';
          console.log('Got params from JSON string body');
        } catch (e) {
          console.log('Body is not valid JSON');
        }
      }
    }

    console.log('=== Request Parameters ===');
    console.log('Method:', req.method);
    console.log('source_wp length:', source_wp?.length || 0);
    console.log('merged_text length:', merged_text?.length || 0);

    // Validation
    if (!source_wp || source_wp.trim() === '') {
      return res.status(400).json({ 
        error: "source_wp is required",
        help: "Add to URL: ?source_wp=your_requirements&merged_text=your_document",
        received: {
          query_params: Object.keys(req.query),
          body_type: typeof req.body
        }
      });
    }

    // Check API keys
    if (!OPENAI_KEY || !OPENAI_KEY.startsWith('sk-')) {
      return res.status(500).json({ 
        error: "OpenAI API key not configured"
      });
    }

    if (!ANTHROPIC_KEY || !ANTHROPIC_KEY.startsWith('sk-ant-')) {
      return res.status(500).json({ 
        error: "Anthropic API key not configured"
      });
    }

    console.log('=== Starting Processing ===');

    const doc = merged_text || "";
    const chunks = doc.length > 10000 ? chunkText(doc, 8000) : [doc];

    console.log(`Processing ${chunks.length} chunk(s)...`);

    // 1) PROCESS CHUNKS
    let processedChunks = [];
    
    if (doc && doc.length > 0) {
      for (let i = 0; i < chunks.length; i++) {
        console.log(`Chunk ${i + 1}/${chunks.length}`);
        
        const system = "You are a document preparation engine. Clean, structure, and clarify this section. Keep all content. Do not summarize.";
        const result = await callGPT(system, chunks[i], 3000);
        processedChunks.push(result);
        
        if (i < chunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    }

    const merged = processedChunks.length > 0 ? processedChunks.join("\n\n---\n\n") : "";

    // 2) GPT MAIN GENERATION
    const systemMain = `You are an expert audit planner specializing in internal audit and quality management systems. Generate comprehensive audit working programs based on user requirements and document content. Apply latest IIA Standards and ISO 19011:2018 guidelines.

Output Requirements:
- Structure: Use HTML semantic tags (<h1>, <h2>, <h3>, <p>, <ul>, <ol>, <table>)
- No CSS or inline styles
- Professional audit documentation tone
- Clear, actionable content
- Include audit objectives, scope, procedures, criteria, resources, and timelines`;

    const documentSection = merged.length > 0 ? 
      `\n\n# DOCUMENT CONTENT\n${merged.substring(0, 25000)}` : '';

    const userMain = `# USER REQUIREMENTS\n${source_wp}${documentSection}\n\nGenerate a complete Audit Working Program in clean HTML.`;

    console.log("Generating GPT draft...");
    const gptDraft = await callGPT(systemMain, userMain, 4000);

    // 3) CLAUDE REVIEW
    const claudeSystem = `You are a senior audit reviewer with expertise in IIA Standards and ISO 19011:2018.

Review and enhance the audit working program draft for:
✓ Technical accuracy and standards compliance
✓ Completeness of all audit program elements
✓ Clarity and professional presentation
✓ Practical implementability

Output: Clean HTML (no CSS), production-ready, with enhanced structure and all content preserved.`;

    const claudeUser = `# USER REQUIREMENTS\n${source_wp}\n\n# GPT DRAFT\n${gptDraft}\n\nProvide final enhanced audit working program in clean HTML.`;

    console.log("Claude review...");
    const finalOutput = await callClaude(claudeSystem, claudeUser);

    console.log("=== Complete ===");

    return res.status(200).json({
      success: true,
      ai_output: finalOutput,
      ai_draft: gptDraft,
      chunks_processed: chunks.length,
      timestamp: new Date().toISOString(),
      metadata: {
        doc_length: doc.length,
        chunks: processedChunks.length,
        models: {
          processing: "gpt-4-turbo-preview",
          review: "claude-sonnet-4-20250514"
        }
      }
    });

  } catch (err) {
    console.error("=== Error ===");
    console.error(err.message);
    console.error(err.stack);
    
    return res.status(500).json({ 
      error: "Processing error", 
      details: err.message,
      timestamp: new Date().toISOString()
    });
  }
};
