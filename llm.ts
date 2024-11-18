import Anthropic from 'npm:@anthropic-ai/sdk@0.32.1'

const models = {
  haiku35: 'claude-3-5-haiku-20241022',
  sonnet: 'claude-3-5-sonnet-20241022',
} as const

type Model = typeof models[keyof typeof models]

type SystemMsg = { text: string; cache?: boolean }

export async function askClaude(model: Model, userMsg: string, systemMsgs: SystemMsg[]) {
  const startTime = performance.now()
  const response = await new Anthropic().beta.promptCaching.messages.create({
    model,
    system: systemMsgs.map(({ text, cache }) => ({
      type: 'text',
      text,
      cache_control: cache ? { type: 'ephemeral' } : undefined,
    })),
    messages: [{ role: 'user' as const, content: userMsg }],
    max_tokens: 2048,
  })
  const timeMs = performance.now() - startTime
  const content = response.content[0]
  return {
    model,
    // we're not doing tool use so we should always get text
    content: content.type === 'text' ? content.text : JSON.stringify(content),
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
  'claude-3-5-sonnet-20241022': {
    input: 3 / M,
    output: 15 / M,
    cacheRead: 0.3 / M,
    cacheWrite: 3.75 / M,
  },
} as const

type Usage = Anthropic.Beta.PromptCaching.Messages.PromptCachingBetaUsage

function getCost(model: Model, usage: Usage) {
  const { input, output, cacheRead, cacheWrite } = prices[model]
  return (
    input * usage.input_tokens +
    output * usage.output_tokens +
    cacheRead * (usage.cache_read_input_tokens || 0) +
    cacheWrite * (usage.cache_creation_input_tokens || 0)
  )
}
