import axios from "axios";

// ENV VARS — set these in Vercel dashboard after deployment
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// ------------- CHUNKING UTILS ------------------

function chunkText(text, max = 6000) {
  const sentences = text.split(/(?<=[.!?])\s+/);
  let chunks = [];
  let current = "";

  for (const s of sentences) {
    if ((current + s).length > max) {
      chunks.push(current);
      current = "";
    }
    current += s + " ";
  }

  if (current.trim().length > 0) chunks.push(current);
  return chunks;
}

// ------------- GPT CALL ------------------------

async function callGPT(system, user) {
  const url = "https://api.openai.com/v1/responses";

  const { data } = await axios.post(
    url,
    {
      model: "gpt-4-turbo-preview",
      input: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.3,
      max_output_tokens: 7000
    },
    {
      headers: { Authorization: `Bearer ${OPENAI_KEY}` }
    }
  );
  return data.choices[0].message.content;
}

// ------------- CLAUDE CALL ----------------------

async function callClaude(system, user) {
  const url = "https://api.anthropic.com/v1/messages";

  const { data } = await axios.post(
    url,
    {
      model: "claude-3-opus-20240229",
      max_tokens: 7000,
      system,
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
}

// ------------- MAIN ORCHESTRATOR ---------------

export default async function handler(req, res) {
  try {
    const { source_wp, merged_text } = req.body;

    if (!source_wp) {
      return res.status(400).json({ error: "source_wp is required" });
    }

    const doc = merged_text || "";
    const chunks = doc.length > 10000 ? chunkText(doc) : [doc];

    // 1) PROCESS ALL CHUNKS THROUGH GPT
    let processedChunks = [];
    for (const ch of chunks) {
      const system =
        "You are a document preparation engine. Clean, structure, and clarify this section. Keep all content. Do not summarize.";
      const user = ch;

      const result = await callGPT(system, user);
      processedChunks.push(result);
    }

    const merged = processedChunks.join("\n\n");

    // 2) SEND MERGED TO GPT FOR MAIN GENERATION
    const systemMain =
      ""You are an expert audit planner. Generate the full audit working program based on user input and document content. Use latest IIA & ISO 19011 standards. Output structured HTML suitable for Bubble web page: <h1>-<h4>, <p>, <ul>/<ol>, <table>. Keep professional, clear, and human-like tone. Maintain all content. No CSS."
";
    const userMain = `
User input:
${source_wp}

Processed document:
${merged}

Generate the Working Program in clean HTML. No CSS.
    `;

    const gptDraft = await callGPT(systemMain, userMain);

    // 3) CLAUDE FINAL REVIEW
    const claudeSystem =
      ""You are a senior audit reviewer. Check the GPT draft for correctness, clarity, completeness, and consistency with IIA & ISO 19011 standards. Improve structure and professional presentation. Maintain all details. Output **ready-to-use clean HTML** suitable for Bubble, no CSS. Do not summarize content."
";
    const finalOutput = await callClaude(claudeSystem, gptDraft);

    return res.status(200).json({
      success: true,
      ai_output: finalOutput,
      ai_draft: gptDraft,
      chunks_used: chunks.length
    });
  } catch (err) {
    console.error(err.response?.data || err);
    return res.status(500).json({ error: "Internal error", details: err.message });
  }
}
