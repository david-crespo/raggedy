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
  docs: Doc[] = [],
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
        ...docs.map((doc) => ({
          type: 'document',
          source: { type: 'text', media_type: 'text/plain', data: doc.content },
          context: doc.relPath,
          cache_control: { type: 'ephemeral' },
          // the citations are hard to use, but the document format is good!
          // citations: { enabled: true },
        } as const)),
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

  const usage = response.usage
  const cost = getCost(model, usage)

  let tokens = `**Tokens:** ${usage.input_tokens}`
  const parts: string[] = []
  if (usage.cache_read_input_tokens) {
    parts.push('**R:** ' + usage.cache_read_input_tokens)
  }
  if (usage.cache_creation_input_tokens) {
    parts.push('**W:** ' + usage.cache_creation_input_tokens)
  }
  if (parts.length > 0) tokens += ` (${parts.join(', ')})`

  tokens += ` -> ${usage.output_tokens}`
  const meta = [
    `\`${model}\``,
    moneyFmt.format(cost),
    timeFmt.format(timeMs / 1000) + ' s',
    tokens,
  ].join(' | ')

  return { content, meta }
}

const prices = {
  '3.5-haiku': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  '3.7-sonnet': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
} as const

const M = 1_000_000

function getCost(model: Model, usage: Anthropic.Messages.Usage) {
  const { input, output, cacheRead, cacheWrite } = prices[model]
  return (
    input * usage.input_tokens / M +
    output * usage.output_tokens / M +
    cacheRead * (usage.cache_read_input_tokens || 0) / M +
    cacheWrite * (usage.cache_creation_input_tokens || 0) / M
  )
}

const moneyFmt = Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 5,
})

const timeFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })
