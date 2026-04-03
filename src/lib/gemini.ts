import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import { AudioInsights } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export async function processAudioWithGemini(base64Audio: string, mimeType: string): Promise<{ transcript: string; insights: AudioInsights }> {
  const model = "gemini-3-flash-preview";
  
  const prompt = `
    Analyze this voice note. 
    1. Transcribe the audio accurately.
    2. Provide a structured analysis including:
       - A brief summary.
       - Core points made.
       - Any questions asked in the note.
       - 3 suggested polite and helpful replies.
    
    Return the result in JSON format.
  `;

  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        parts: [
          { text: prompt },
          { inlineData: { data: base64Audio, mimeType } }
        ]
      }
    ],
    config: {
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          transcript: { type: Type.STRING, description: "The full transcript of the audio." },
          insights: {
            type: Type.OBJECT,
            properties: {
              summary: { type: Type.STRING },
              key_points: { type: Type.ARRAY, items: { type: Type.STRING } },
              questions: { type: Type.ARRAY, items: { type: Type.STRING } },
              suggested_replies: { type: Type.ARRAY, items: { type: Type.STRING } }
            },
            required: ["summary", "key_points", "questions", "suggested_replies"]
          }
        },
        required: ["transcript", "insights"]
      }
    }
  });

  const result = JSON.parse(response.text || "{}");
  return result;
}
