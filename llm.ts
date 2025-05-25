import { GoogleGenAI } from 'npm:@google/genai@0.14.0'

export interface Doc {
  relPath: string
  content: string
  head: string
  headings: string
}

const M = 1_000_000

type TokenCounts = { input: number; output: number; input_cache_hit: number }

const apiKey = Deno.env.get('GEMINI_API_KEY')
if (!apiKey) throw new Error('GEMINI_API_KEY required')

export async function askGemini(
  userMsg: string,
  systemMsgs: string[],
  docs: Doc[] = [],
) {
  const startTime = performance.now()
  const result = await new GoogleGenAI({ apiKey }).models.generateContent({
    config: {
      maxOutputTokens: 1024,
      thinkingConfig: { thinkingBudget: 0 },
      systemInstruction: systemMsgs.join('\n\n'),
    },
    model: 'gemini-2.5-flash-preview-05-20',
    contents: [
      ...docs.map((doc) => `<document>${doc.content}</document>`),
      userMsg,
    ],
  })
  const timeMs = performance.now() - startTime

  const usage: TokenCounts = {
    input: result.usageMetadata!.promptTokenCount || 0,
    output: result.usageMetadata!.candidatesTokenCount || 0,
    input_cache_hit: result.usageMetadata!.cachedContentTokenCount || 0,
  }

  const cost = (0.15 * (usage.input - usage.input_cache_hit) / M) +
    (0.60 * usage.output / M) +
    (0.0375 * usage.input_cache_hit / M)

  const content = result.candidates?.[0].content?.parts?.map((p) => p.text).join('\n\n')!

  let tokens = `**Tokens:** ${usage.input}`
  const parts: string[] = []
  if (usage.input_cache_hit) parts.push('**R:** ' + usage.input_cache_hit)

  if (parts.length > 0) tokens += ` (${parts.join(', ')})`

  tokens += ` -> ${usage.output}`
  const meta = [
    `\`gemini-2.5-flash\``,
    moneyFmt.format(cost),
    timeFmt.format(timeMs / 1000) + ' s',
    tokens,
  ].join(' | ')

  return { content, meta }
}

const moneyFmt = Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 5,
})

const timeFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })
