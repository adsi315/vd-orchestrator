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
    console.log('Calling GPT with max_tokens:', maxTokens);
    
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
    
    console.log('GPT Response structure:', {
      has_choices: !!data.choices,
      choices_length: data.choices?.length,
      has_message: !!data.choices?.[0]?.message,
      finish_reason: data.choices?.[0]?.finish_reason
    });
    
    // Validate response structure
    if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
      console.error('Invalid GPT response structure:', JSON.stringify(data, null, 2));
      throw new Error('GPT returned invalid response structure');
    }
    
    if (!data.choices[0].message || !data.choices[0].message.content) {
      console.error('GPT choice missing message or content:', JSON.stringify(data.choices[0], null, 2));
      throw new Error('GPT response missing message content');
    }
    
    return data.choices[0].message.content;
    
  } catch (error) {
    console.error("GPT Error Details:");
    console.error("- Status:", error.response?.status);
    console.error("- Error data:", JSON.stringify(error.response?.data, null, 2));
    console.error("- Message:", error.message);
    
    // Extract useful error message
    const errorMessage = error.response?.data?.error?.message || 
                        error.response?.data?.message || 
                        error.message;
    
    throw new Error(`GPT call failed: ${errorMessage}`);
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
    
    console.log('Claude Response structure:', {
      has_content: !!data.content,
      content_length: data.content?.length,
      first_content_type: data.content?.[0]?.type
    });
    
    // Validate response structure
    if (!data.content || !Array.isArray(data.content) || data.content.length === 0) {
      console.error('Invalid Claude response structure:', JSON.stringify(data, null, 2));
      throw new Error('Claude returned invalid response structure');
    }
    
    if (!data.content[0].text) {
      console.error('Claude content missing text:', JSON.stringify(data.content[0], null, 2));
      throw new Error('Claude response missing text content');
    }
    
    return data.content[0].text;
    
  } catch (error) {
    console.error("Claude Error Details:");
    console.error("- Status:", error.response?.status);
    console.error("- Error data:", JSON.stringify(error.response?.data, null, 2));
    console.error("- Message:", error.message);
    
    // Extract useful error message
    const errorMessage = error.response?.data?.error?.message || 
                        error.response?.data?.message || 
                        error.message;
    
    throw new Error(`Claude call failed: ${errorMessage}`);
  }
}

// ------------- ROBUST BODY PARSER ---------------
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    
    req.on('data', chunk => {
      data += chunk.toString();
    });
    
    req.on('end', () => {
      resolve(data);
    });
    
    req.on('error', reject);
    
    setTimeout(() => reject(new Error('Body read timeout')), 10000);
  });
}

async function parseRequestBody(req) {
  console.log('=== Request Debug Info ===');
  console.log('Method:', req.method);
  console.log('Content-Type:', req.headers['content-type']);
  console.log('Body type (initial):', typeof req.body);
  
  try {
    // Case 1: Body already parsed as object
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      console.log('Body already parsed as object');
      console.log('Keys:', Object.keys(req.body));
      return req.body;
    }
    
    // Case 2: Body is a string
    if (typeof req.body === 'string' && req.body.trim()) {
      console.log('Body is string, length:', req.body.length);
      try {
        const parsed = JSON.parse(req.body);
        console.log('Successfully parsed string body');
        return parsed;
      } catch (e) {
        console.log('String body is not valid JSON');
        if (req.body.includes('=')) {
          const params = new URLSearchParams(req.body);
          const result = {};
          for (const [key, value] of params) {
            result[key] = value;
          }
          console.log('Parsed as URL-encoded:', Object.keys(result));
          return result;
        }
        throw new Error('Body is string but not valid JSON or URL-encoded');
      }
    }
    
    // Case 3: Read from stream
    console.log('Attempting to read raw body from stream...');
    const rawBody = await getRawBody(req);
    console.log('Raw body length:', rawBody.length);
    console.log('Raw body preview:', rawBody.substring(0, 200));
    
    if (!rawBody || rawBody.trim() === '') {
      console.log('Empty body received');
      return {};
    }
    
    try {
      const parsed = JSON.parse(rawBody);
      console.log('Successfully parsed raw body as JSON');
      return parsed;
    } catch (e) {
      console.log('Raw body parse error:', e.message);
      
      if (rawBody.includes('=')) {
        const params = new URLSearchParams(rawBody);
        const result = {};
        for (const [key, value] of params) {
          result[key] = value;
        }
        console.log('Parsed raw body as URL-encoded');
        return result;
      }
      
      throw new Error(`Unable to parse body. Preview: ${rawBody.substring(0, 100)}`);
    }
    
  } catch (error) {
    console.error('Body parsing error:', error);
    throw error;
  }
}

// ------------- MAIN ORCHESTRATOR ---------------
module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'ok',
      message: 'Orchestrator API is running',
      endpoint: '/api/orchestrator',
      method_required: 'POST',
      env_check: {
        openai_key_exists: !!OPENAI_KEY,
        openai_key_format: OPENAI_KEY ? `${OPENAI_KEY.substring(0, 7)}...` : 'missing',
        anthropic_key_exists: !!ANTHROPIC_KEY,
        anthropic_key_format: ANTHROPIC_KEY ? `${ANTHROPIC_KEY.substring(0, 7)}...` : 'missing'
      }
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ 
      error: 'Method not allowed',
      allowed_methods: ['POST', 'OPTIONS', 'GET']
    });
  }

  let parsedBody;
  
  // Support query parameters as fallback
  if (req.query && (req.query.source_wp || Object.keys(req.query).length > 0)) {
    console.log('Using query parameters');
    parsedBody = {
      source_wp: req.query.source_wp || '',
      merged_text: req.query.merged_text || ''
    };
  } else {
    try {
      parsedBody = await parseRequestBody(req);
      console.log('Final parsed body keys:', Object.keys(parsedBody));
    } catch (parseError) {
      console.error('Failed to parse request body:', parseError);
      return res.status(400).json({
        error: 'Invalid request format',
        details: parseError.message,
        help: 'Send POST with JSON body: {"source_wp":"...","merged_text":"..."}'
      });
    }
  }

  try {
    const { source_wp, merged_text } = parsedBody;

    // Validation
    if (!source_wp || source_wp.trim() === '') {
      return res.status(400).json({ 
        error: "source_wp field is required and cannot be empty",
        received_fields: Object.keys(parsedBody),
        received_source_wp: source_wp
      });
    }

    // Check API keys
    if (!OPENAI_KEY || !OPENAI_KEY.startsWith('sk-')) {
      return res.status(500).json({ 
        error: "OpenAI API key not configured correctly",
        help: "Set OPENAI_API_KEY in Vercel environment variables (should start with 'sk-')"
      });
    }

    if (!ANTHROPIC_KEY || !ANTHROPIC_KEY.startsWith('sk-ant-')) {
      return res.status(500).json({ 
        error: "Anthropic API key not configured correctly",
        help: "Set ANTHROPIC_API_KEY in Vercel environment variables (should start with 'sk-ant-')"
      });
    }

    console.log('=== Starting Processing ===');
    console.log('Source WP length:', source_wp.length);
    console.log('Merged text length:', merged_text?.length || 0);

    const doc = merged_text || "";
    const chunks = doc.length > 10000 ? chunkText(doc, 8000) : [doc];

    console.log(`Processing ${chunks.length} chunk(s)...`);

    // 1) PROCESS CHUNKS THROUGH GPT
    let processedChunks = [];
    
    if (doc && doc.length > 0) {
      for (let i = 0; i < chunks.length; i++) {
        console.log(`Processing chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)`);
        
        const system = "You are a document preparation engine. Clean, structure, and clarify this section. Keep all content. Do not summarize.";
        const user = chunks[i];
        
        const result = await callGPT(system, user, 3000);
        processedChunks.push(result);
        
        // Rate limiting
        if (i < chunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    }

    const merged = processedChunks.length > 0 ? processedChunks.join("\n\n---\n\n") : "";
    console.log("Chunks processed. Merged length:", merged.length);

    // 2) GPT MAIN GENERATION
    const systemMain = `You are an expert audit planner specializing in internal audit and quality management systems. Generate comprehensive audit working programs based on user requirements and document content. Apply latest IIA Standards and ISO 19011:2018 guidelines.

Output Requirements:
- Structure: Use HTML semantic tags (<h1>, <h2>, <h3>, <p>, <ul>, <ol>, <table>)
- No CSS or inline styles
- Professional audit documentation tone
- Clear, actionable content
- Maintain all substantive information
- Include audit objectives, scope, procedures, criteria, resources, and timelines where applicable`;

    const documentSection = merged.length > 0 ? 
      `\n\n# DOCUMENT CONTENT (Processed)\n${merged.substring(0, 25000)}` : 
      '';

    const userMain = `# USER REQUIREMENTS
${source_wp}${documentSection}

Generate a complete, professional Audit Working Program in clean HTML format. Structure it with clear sections covering all essential audit program elements.`;

    console.log("Generating GPT main draft...");
    const gptDraft = await callGPT(systemMain, userMain, 4000);
    console.log("GPT draft generated. Length:", gptDraft.length);

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
    console.log("Claude review complete. Length:", finalOutput.length);

    console.log("=== Process Complete ===");

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
    console.error("=== Orchestrator Error ===");
    console.error("Error:", err.message);
    console.error("Stack:", err.stack);
    
    return res.status(500).json({ 
      error: "Internal processing error", 
      details: err.message,
      timestamp: new Date().toISOString()
    });
  }
};
