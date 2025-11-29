// orchestrator.js
// Dual-LLM Orchestrator: GPT (creator) -> Claude (reviewer)
// Handles compressed input, chunking, pdf/docx extraction, and safe JSON parsing.

const axios = require('axios');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const LZString = require('lz-string');

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// ---------------------- Helpers ----------------------
async function extractPDF(buffer) {
  try {
    const d = await pdfParse(buffer);
    return d.text || '';
  } catch (e) {
    console.warn('PDF extraction failed:', e.message || e);
    return '';
  }
}

async function extractWord(buffer) {
  try {
    const { value } = await mammoth.extractRawText({ buffer });
    return value || '';
  } catch (e) {
    console.warn('Word extraction failed:', e.message || e);
    return '';
  }
}

function chunkText(text, max = 8000) {
  if (!text) return [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  let chunks = [];
  let current = '';
  for (const s of sentences) {
    if ((current + s).length > max) {
      if (current.trim()) chunks.push(current.trim());
      current = '';
    }
    current += s + ' ';
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function safeParseJson(maybeJson) {
  if (!maybeJson || typeof maybeJson !== 'string') return null;
  // Try direct parse
  try {
    return JSON.parse(maybeJson);
  } catch (e) {
    // Try to find a JSON object inside the text (first { ... } or [ ... ])
    const objMatch = maybeJson.match(/(\{[\s\S]*\})/);
    const arrMatch = maybeJson.match(/(\[[\s\S]*\])/);
    const candidate = objMatch ? objMatch[1] : (arrMatch ? arrMatch[1] : null);
    if (candidate) {
      try {
        return JSON.parse(candidate);
      } catch (e2) {
        // try to fix common trailing commas
        const fixed = candidate.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
        try {
          return JSON.parse(fixed);
        } catch (e3) {
          return null;
        }
      }
    }
    return null;
  }
}

// ---------------------- LLM Calls ----------------------
async function callClaude(systemPrompt, userPrompt) {
  const payload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 16000,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }]
  };
  const { data } = await axios.post("https://api.anthropic.com/v1/messages", payload, {
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    timeout: 120000
  });
  return data?.content?.[0]?.text ?? '';
}

async function callGPT(systemPrompt, userPrompt) {
  const payload = {
    model: "gpt-4-turbo-preview",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.15,
    max_tokens: 4000
  };
  const { data } = await axios.post("https://api.openai.com/v1/chat/completions", payload, {
    headers: {
      "Authorization": `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json"
    },
    timeout: 120000
  });
  return data?.choices?.[0]?.message?.content ?? '';
}

// ---------------------- Prompt Builders ----------------------
function buildCreatorPrompt(documentText, userInputs) {
  return `
You are an expert Internal Audit Working Program designer and technical writer.

TASK:
Using the DOCUMENT and USER INPUTS below, create a complete, testable, and professional Internal Audit Working Program suitable for use by auditors, QA, Risk, IC, and department heads.

DOCUMENT:
${documentText}

USER INPUTS / CRITERIA:
${userInputs}

REQUIREMENTS:
- Follow international internal audit practices (IIA), COSO, and reference ISO where applicable.
- Produce clear step-by-step audit procedures with numbering and grouping.
- For each procedure include: responsible party/role, expected evidence, sample size guidance if applicable, references to relevant SOP/policy, and tips for the auditor.
- Produce an executive summary, scope, objectives, risk overview (if present), and concluding remarks.
- Output two parts:
  1) The full HTML-rendered Working Program (inline CSS, ready for screen and PDF/docx export).
  2) A JSON array named "procedures" with objects:
     {"procedure_id","section","subsection","procedure_text","assertion_or_control_ref","risk_addressed","expected_evidence","notes_for_auditor"}
  3) A JSON array named "finding_templates" with the 5C (Condition, Criteria, Cause, Consequence, Corrective Action) skeleton for each procedure.

OUTPUT FORMAT:
Return a JSON object exactly as:
{
  "html_program": "<HTML string>",
  "procedures": [...],
  "finding_templates": [...]
}

Do NOT include commentary outside the JSON. Ensure JSON is valid and the html_program field is fully escaped for JSON.
`;
}

function buildReviewerPrompt(gptDraftJson, documentText, userInputs) {
  return `
You are a Senior Quality Assurance Auditor and editor.

You will receive a DRAFT Working Program (created by GPT). Your role is to refine, correct, and finalize it into one high-quality, cohesive Working Program that is:
- Accurate, unambiguous, and audit-ready
- Compliant with IIA/COSO/ISO where relevant
- Clear in steps, responsibilities, and evidence requirements
- Formatted as clean HTML ready for export and display
- Provides a clean, validated JSON "procedures" array and "finding_templates" array suitable for direct import into a repeating group (Bubble)

INPUTS:
DRAFT (from Creator):
${typeof gptDraftJson === 'string' ? gptDraftJson : JSON.stringify(gptDraftJson)}

ORIGINAL DOCUMENT (for reference):
${documentText}

USER INPUTS:
${userInputs}

TASK:
- Validate the draft, correct logic gaps, unify style, fix formatting and numbering.
- Ensure every procedure is testable and contains expected evidence and sample logic where applicable.
- Ensure the procedures array is clean JSON objects with proper IDs.
- Ensure the finding_templates follow 5C: Condition, Criteria, Cause, Consequence, Corrective Action.

OUTPUT:
Return a single JSON object:
{
  "html_program": "<FINAL_HTML>",
  "procedures": [...],
  "finding_templates": [...]
}

Do NOT output anything other than this JSON.
`;
}

// ---------------------- Main Handler ----------------------
module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    // Parse body: accept JSON object or raw text
    let body = req.body;
    if (!body || (Object.keys(body).length === 0 && req.rawBody)) {
      // For some deployment environments rawBody may be present
      try {
        body = JSON.parse(req.rawBody.toString());
      } catch (e) {
        // try read as plain text
        body = req.rawBody?.toString() || body;
      }
    }

    // Accept either object or raw string
    let document_text = '';
    let user_inputs = '';

    if (typeof body === 'string') {
      document_text = body;
    } else if (typeof body === 'object') {
      // Support both compressed and plain fields, and uploaded file
      document_text = body.document_text || body.source_wp || '';
      user_inputs = body.user_inputs || body.user_inputs_text || '';
      // Support uploaded_file: { file_type, base64 }
      if ((!document_text || document_text.length < 10) && body.uploaded_file?.base64) {
        const fileType = (body.uploaded_file.file_type || '').toLowerCase();
        const buf = Buffer.from(body.uploaded_file.base64, 'base64');
        if (fileType.includes('pdf') || body.uploaded_file.file_type === 'pdf') {
          document_text = await extractPDF(buf);
        } else {
          // try word extraction
          document_text = await extractWord(buf);
        }
      }
    } else {
      return res.status(400).json({ error: 'Invalid request body' });
    }

    // Decompress if prefixed
    if (typeof document_text === 'string' && document_text.startsWith('COMPRESSED:')) {
      const raw = document_text.replace(/^COMPRESSED:/, '');
      const dec = LZString.decompressFromEncodedURIComponent(raw);
      document_text = dec || '';
    }

    if (!document_text || document_text.trim().length < 10) {
      return res.status(400).json({ error: 'No document_text available to process' });
    }

    // If no user inputs provided, set default minimal context
    if (!user_inputs || typeof user_inputs !== 'string') {
      user_inputs = 'Produce a clear, testable internal audit working program based on the document.';
    }

    // Chunking strategy: if very large, create section drafts and merge
    const chunks = document_text.length > 25000 ? chunkText(document_text, 12000) : [document_text];

    // 1) Creator (GPT) — produce draft for each chunk then merge
    let gptDraftPieces = [];
    for (let i = 0; i < chunks.length; i++) {
      const docPart = chunks[i];
      const systemPrompt = "You are GPT, an expert audit working program creator.";
      const userPrompt = buildCreatorPrompt(docPart, user_inputs) + `\n\n/* PART ${i+1} of ${chunks.length} */`;

      const gptResponse = await callGPT(systemPrompt, userPrompt);
      gptDraftPieces.push(gptResponse);

      // small pause
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 500));
    }

    // Attempt to combine GPT draft pieces intelligently:
    let combinedGptDraft = gptDraftPieces.join("\n\n");

    // Try to parse JSON from GPT draft; if it returned JSON object, capture it,
    // otherwise pass whole draft string to reviewer.
    let gptDraftJson = safeParseJson(combinedGptDraft);

    // If not JSON, wrap the raw draft into an object form that the reviewer will accept.
    if (!gptDraftJson) {
      // We'll give reviewer the full text under a "draft" field
      gptDraftJson = {
        draft_text: combinedGptDraft
      };
    }

    // 2) Reviewer (Claude) — refine & finalize single JSON output
    const reviewerSystem = "You are Claude, an expert senior auditor and editor.";
    const reviewerUserPrompt = buildReviewerPrompt(gptDraftJson, document_text, user_inputs);

    const claudeResponse = await callClaude(reviewerSystem, reviewerUserPrompt);

    // Claude is instructed to return a single JSON object. Parse it.
    const finalJson = safeParseJson(claudeResponse);

    // If parsing failed, attempt fallback: request Claude to return only JSON (quick retry)
    let finalOutput = finalJson;
    if (!finalOutput) {
      // Retry: ask Claude to ONLY output JSON (short)
      const retrySystem = "You are Claude. We need ONLY a single JSON object as previously specified.";
      const retryUser = `Previous output was not valid JSON. Please return ONLY the final JSON object with keys: html_program, procedures, finding_templates. Use proper JSON syntax.`;
      const retryResp = await callClaude(retrySystem, retryUser + "\n\nPrevious was:\n" + claudeResponse);
      finalOutput = safeParseJson(retryResp);
    }

    // As a last fallback, construct a minimal structure from available pieces
    if (!finalOutput) {
      // Build a simple safe fallback that includes raw GPT draft in html and empty arrays for procedures
      finalOutput = {
        html_program: `<pre>${escapeHtml(combinedGptDraft).slice(0, 50000)}</pre>`,
        procedures: [],
        finding_templates: []
      };
    }

    // Also try to extract procedures_for_arg (procedures array) for frontend RG usage
    const proceduresForArg = Array.isArray(finalOutput.procedures) ? finalOutput.procedures : [];

    // Prepare a clean HTML output (if the reviewer returned html_program, use it; otherwise try raw)
    const finalHtml = typeof finalOutput.html_program === 'string' && finalOutput.html_program.trim().length > 0
      ? finalOutput.html_program
      : `<html><body><pre>${escapeHtml(combinedGptDraft).slice(0, 200000)}</pre></body></html>`;

    // Return final response
    return res.status(200).json({
      success: true,
      creator_raw: combinedGptDraft,
      reviewer_raw: claudeResponse,
      final_json: finalOutput,
      html_output: finalHtml,
      procedures_for_arg: proceduresForArg,
      chunks_processed: chunks.length,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('=== ORCHESTRATOR ERROR ===', err);
    return res.status(500).json({
      error: err.message || String(err),
      details: err.response?.data || null
    });
  }
};

// ---------------------- Utility ----------------------
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
