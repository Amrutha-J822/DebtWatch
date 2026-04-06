/**
 * Gemini API access for the backend. Set `GEMINI_API_KEY` in `backend/.env`
 * (see `@google/genai`: Node client defaults to the same env var when no apiKey is passed).
 */
import '../env.js';
import { GenerateContentResponse, GoogleGenAI, Modality, ThinkingLevel } from '@google/genai';

let client: GoogleGenAI | null = null;

/** Override with GEMINI_REASONING_MODEL if a preview/pro model hits free-tier quota (RESOURCE_EXHAUSTED). */
const REASONING_MODEL =
  process.env.GEMINI_REASONING_MODEL?.trim() || 'gemini-3.1-pro-preview';
const IMAGE_MODEL =
  process.env.GEMINI_IMAGE_MODEL?.trim() || 'gemini-3.1-flash-image-preview';

function getGeminiApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key?.trim()) {
    throw new Error('GEMINI_API_KEY is missing (set it in backend/.env)');
  }
  return key.trim();
}

export function getGemini(): GoogleGenAI {
  if (!client) {
    client = new GoogleGenAI({ apiKey: getGeminiApiKey() });
  }
  return client;
}

function responseTextFromParts(response: Awaited<
  ReturnType<GoogleGenAI['models']['generateContent']>
>): string {
  const direct = response.text;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const parts = response.candidates?.[0]?.content?.parts;
  if (!parts?.length) return '';
  let out = '';
  for (const part of parts) {
    if ('text' in part && part.text) out += part.text;
  }
  return out;
}

/**
 * Text generation with the reasoning model (default: gemini-3.1-pro-preview).
 * Drop-in replacement for the previous Anthropic helper used by the scanner.
 */
export async function geminiReasoningText(
  userMessage: string,
  options?: { system?: string; maxTokens?: number },
): Promise<string> {
  const maxTokens = options?.maxTokens ?? 8192;
  const ai = getGemini();
  const response = await ai.models.generateContent({
    model: REASONING_MODEL,
    contents: userMessage,
    config: {
      ...(options?.system ? { systemInstruction: options.system } : {}),
      maxOutputTokens: maxTokens,
    },
  });
  const text = responseTextFromParts(response);
  // #region agent log
  fetch('http://127.0.0.1:7739/ingest/aa9c7ad1-d90c-453c-ae07-9977acb5e540', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Debug-Session-Id': '1623b3',
    },
    body: JSON.stringify({
      sessionId: '1623b3',
      hypothesisId: 'H_gemini_swap',
      location: 'gemini.ts:geminiReasoningText',
      message: 'Gemini reasoning response',
      data: {
        model: REASONING_MODEL,
        textLen: text.length,
        hasCandidates: Boolean(response.candidates?.length),
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
  return text;
}

/**
 * Native image generation (gemini-3.1-flash-image-preview by default).
 * Not used by the current repo scanner; optional for future features (e.g. real PNG exports).
 */
export async function geminiGenerateImagePng(
  prompt: string,
): Promise<{ mimeType: string; data: Buffer } | null> {
  const ai = getGemini();
  const response = await ai.models.generateContent({
    model: IMAGE_MODEL,
    contents: prompt,
  });
  const parts = response.candidates?.[0]?.content?.parts;
  if (!parts) return null;
  for (const part of parts) {
    if ('inlineData' in part && part.inlineData?.data) {
      const mime = part.inlineData.mimeType ?? 'image/png';
      return {
        mimeType: mime,
        data: Buffer.from(part.inlineData.data, 'base64'),
      };
    }
  }
  return null;
}

export type GeminiInfographicResult = { mimeType: string; dataBase64: string };

/**
 * Streamed image+text from gemini-3.1-flash-image-preview (Nano Banana–class).
 * Collects concatenated text and the latest inline image (infographic).
 */
async function consumeInfographicStream(
  stream: AsyncIterable<GenerateContentResponse>,
): Promise<{ text: string; image: GeminiInfographicResult | null }> {
  let text = '';
  let image: GeminiInfographicResult | null = null;

  for await (const chunk of stream) {
    if (typeof chunk.text === 'string' && chunk.text.length > 0) {
      text += chunk.text;
    }
    const parts = chunk.candidates?.[0]?.content?.parts;
    if (!parts?.length) continue;
    for (const part of parts) {
      if ('text' in part && part.text) text += part.text;
      if ('inlineData' in part && part.inlineData?.data) {
        image = {
          mimeType: part.inlineData.mimeType ?? 'image/png',
          dataBase64: part.inlineData.data,
        };
      }
    }
  }

  return { text: text.trim(), image };
}

export async function geminiRepoInfographicStream(
  userPrompt: string,
): Promise<{ text: string; image: GeminiInfographicResult | null }> {
  const ai = getGemini();
  const contents = [
    {
      role: 'user' as const,
      parts: [{ text: userPrompt }],
    },
  ];
  const baseConfig = {
    temperature: 1,
    thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
    responseModalities: [Modality.TEXT, Modality.IMAGE],
    imageConfig: {
      aspectRatio: '16:9',
      imageSize: '1K',
    },
  };

  try {
    const stream = await ai.models.generateContentStream({
      model: IMAGE_MODEL,
      contents,
      config: {
        ...baseConfig,
        tools: [
          {
            googleSearch: {
              searchTypes: {
                imageSearch: {},
              },
            },
          },
        ],
      },
    });
    return await consumeInfographicStream(stream);
  } catch (firstErr) {
    console.warn(
      '[gemini] infographic with imageSearch failed, retrying without tools:',
      firstErr instanceof Error ? firstErr.message : firstErr,
    );
    const stream = await ai.models.generateContentStream({
      model: IMAGE_MODEL,
      contents,
      config: baseConfig,
    });
    return await consumeInfographicStream(stream);
  }
}
