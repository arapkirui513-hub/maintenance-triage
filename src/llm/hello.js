import OpenAI from "openai";

const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL,
  apiKey: process.env.LLM_API_KEY,
  timeout: 30_000, // matches src/llm/client.js, not the SDK's 10-minute default
});

const res = await client.chat.completions.create({
  model: process.env.LLM_MODEL,
  messages: [{ role: "user", content: "Reply with exactly the word: ready" }],
});

console.log(res.choices[0].message.content);
