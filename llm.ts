import Anthropic from 'npm:@anthropic-ai/sdk@0.39.0'

export interface Doc {
  relPath: string
  content: string
  head: string
  headings: string
}

type Model = '3.5-haiku' | '3.7-sonnet'

type SystemMsg = { text: string; cache?: boolean }

export async function askClaude(
  model: Model,
  userMsg: string,
  systemMsgs: SystemMsg[],
  documents: Doc[] = [],
) {
  const startTime = performance.now()
  const response = await new Anthropic().messages.create({
    model: model === '3.5-haiku'
      ? 'claude-3-5-haiku-20241022'
      : 'claude-3-7-sonnet-20250219',
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
  const cost = getCost(model, response.usage)
  const { cache_read_input_tokens, input_tokens, output_tokens } = response.usage
  return {
    content,
    meta: [
      `\`${model}\``,
      moneyFmt.format(cost),
      timeFmt.format(timeMs / 1000) + ' s',
      `**Tokens:** ${input_tokens} (${cache_read_input_tokens}) -> ${output_tokens}`,
    ].join(' | '),
  }
}

// cost calculation

const M = 1_000_000

const prices = {
  '3.5-haiku': {
    input: 1 / M,
    output: 5 / M,
    cacheRead: 0.1 / M,
    cacheWrite: 1.25 / M,
  },
  '3.7-sonnet': {
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

const moneyFmt = Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 5,
})

const timeFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })
