import Anthropic from 'npm:@anthropic-ai/sdk@0.39.0'

export interface Doc {
  relPath: string
  content: string
  head: string
  headings: string
}

export const models = {
  haiku35: 'claude-3-5-haiku-20241022',
  sonnet: 'claude-3-7-sonnet-20250219',
} as const

type Model = (typeof models)[keyof typeof models]

type SystemMsg = { text: string; cache?: boolean }

export async function askClaude(
  model: Model,
  userMsg: string,
  systemMsgs: SystemMsg[],
  documents: Doc[] = [],
) {
  const startTime = performance.now()
  const response = await new Anthropic().messages.create({
    model,
    system: systemMsgs.map(({ text, cache }) => ({
      type: 'text',
      text,
      cache_control: cache ? { type: 'ephemeral' } : undefined,
    })),
    messages: [{
      role: 'user' as const,
      content: [
        ...documents.map(docToDoc),
        { type: 'text', text: userMsg },
      ],
    }],
    max_tokens: 2048,
  })
  const timeMs = performance.now() - startTime
  // we're not doing tool use, so we should always get text
  const content = response.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('')
  return {
    model,
    content,
    cost: getCost(model, response.usage),
    timeMs,
  }
}

// cost calculation

const M = 1_000_000

const prices = {
  'claude-3-5-haiku-20241022': {
    input: 1 / M,
    output: 5 / M,
    cacheRead: 0.1 / M,
    cacheWrite: 1.25 / M,
  },
  'claude-3-7-sonnet-20250219': {
    input: 3 / M,
    output: 15 / M,
    cacheRead: 0.3 / M,
    cacheWrite: 3.75 / M,
  },
} as const

type Usage = Anthropic.Beta.Messages.BetaUsage

function getCost(model: Model, usage: Usage) {
  const { input, output, cacheRead, cacheWrite } = prices[model]
  return (
    input * usage.input_tokens +
    output * usage.output_tokens +
    cacheRead * (usage.cache_read_input_tokens || 0) +
    cacheWrite * (usage.cache_creation_input_tokens || 0)
  )
}

function docToDoc(doc: Doc): Anthropic.Messages.DocumentBlockParam {
  return {
    type: 'document',
    source: {
      type: 'text',
      media_type: 'text/plain',
      data: doc.content,
    },
    context: doc.relPath,
    cache_control: { type: 'ephemeral' },
    // the citations are actually bad, but the document format is good!
    // citations: { enabled: true },
  }
}
