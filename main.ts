#! /usr/bin/env -S deno run --allow-read --allow-env --allow-net --allow-run=glow
import { parseArgs } from 'jsr:@std/cli@1.0/parse-args'
import { relative } from 'jsr:@std/path@1.0'
import { walk } from 'jsr:@std/fs@1.0/walk'
import Anthropic from 'npm:@anthropic-ai/sdk@0.32.1'
import $ from 'jsr:@david/dax@0.42.0'

// TODO: CLI help string

const RENDERER = 'glow'
async function renderMd(md: string, raw = false) {
  if ($.commandExistsSync(RENDERER) && Deno.stdout.isTerminal() && !raw) {
    await $`${RENDERER}`.stdinText(md)
  } else {
    console.log(md)
  }
}

const moneyFmt = Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 5,
})

const timeFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

type ResponseMeta = { model: string; cost: number; timeMs: number }
const meta = ({ model, cost, timeMs }: ResponseMeta) =>
  `\`${model}\` | ${moneyFmt.format(cost)} | ${timeFmt.format(timeMs / 1000)} s`

interface Doc {
  relPath: string
  content: string
  head: string
  headings: string
}

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

export function getCost(model: Model, usage: Usage) {
  const { input, output, cacheRead, cacheWrite } = prices[model]
  return (
    input * usage.input_tokens +
    output * usage.output_tokens +
    cacheRead * (usage.cache_read_input_tokens || 0) +
    cacheWrite * (usage.cache_creation_input_tokens || 0)
  )
}

function getIndex(dir: string): Promise<Doc[]> {
  const files = walk(dir, { includeDirs: false, exts: ['md', 'adoc'] })
  return Array.fromAsync(files, async ({ path }) => {
    const content = await Deno.readTextFile(path)
    const relPath = relative(dir, path)
    const headingPattern = path.endsWith('.adoc') ? /^=+\s+.*/gm : /^#+\s+.*/gm
    const headings = (content.match(headingPattern)?.map((h) => h.trim()) || []).join('\n')
    const head = content.slice(0, 500)
    return { relPath, content, head, headings }
  })
}

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

const retrievalSystemPrompt = $.dedent`
  Which of the files are likely to be relevant to the following question?

  - Put more relevant documents first because the list may be truncated.
  - Return at most 4 documents
  - Your response must be an array of relative paths.
  - The result must be parseable JSON. Do not wrap the answer in a markdown code block and do not attempt to answer the question.
`

/**
 * Determine which subset of the documents is relevant to the question.
 */
async function retrieve(index: Doc[], question: string) {
  const result = await askClaude(
    models.haiku35,
    `${retrievalSystemPrompt}\n\n<question>${question}</question>`,
    [{
      text: index.map((doc) =>
        $.dedent`
        <document>
          <path>${doc.relPath}</path>
          <sections>${doc.headings}</sections>
          <head>${doc.head}</head>
        </document>`
      ).join('\n'),
      cache: true,
    }],
  )
  const paths = JSON.parse(result.content)
  // TODO: warn if there's a path returned that's not in the array
  return {
    ...result,
    // 4 is the max system prompts cacheable in the Anthropic API
    docs: index.filter((doc) => paths.includes(doc.relPath)).slice(0, 4),
  }
}

const fullPromptSystemMsg = `
Answer the user's questions based on the above documentation.

* The documentation may be truncated, so do not assume it is comprehensive of the corpus or even all potentially relevant documents in the corpus.
* If you do not find the answer in the above sources, say so. You may speculate, but be clear that you are doing so.
* Write naturally in prose. Do not overuse markdown headings and bullets.
* Your answer must be in markdown format.
* This is a one-time answer, not a chat, so don't prompt for followup questions
`.trim()

/**
 * Pass the relevant docs to the LLM along with the question and get an answer.
 */
async function getAnswer(relevantDocs: Doc[], question: string) {
  const result = await askClaude(
    models.haiku35,
    question,
    [
      { text: fullPromptSystemMsg },
      // pass in relevant docs as separate system prompts so they can be cached
      ...relevantDocs.map((doc) => ({
        text: $.dedent`
        <document>
          <path>${doc.relPath}</path>
          <content>${doc.content}</content>
        </document>`,
        cache: true,
      })),
    ],
  )
  return result
}

if (import.meta.main) {
  const args = parseArgs(Deno.args)

  const [dir, ...qParts] = args._.map(String)
  if (!dir) throw new Error('Please provide a directory path')

  const question = qParts.join(' ')
  if (!question) throw new Error('Please provide a query')

  const index = await getIndex(dir)

  let pb = $.progress('Finding relevant files...')
  const retrieved = await pb.with(() => retrieve(index, question))

  const pathBullets = retrieved.docs.map((d) => `- \`${d.relPath}\``).join('\n')
  renderMd(`# Relevant files\n\n${meta(retrieved)}\n\n${pathBullets}`)

  pb = $.progress('Getting answer...')
  const answer = await pb.with(() => getAnswer(retrieved.docs, question))
  renderMd(`# Answer\n\n${meta(answer)}\n\n${answer.content}`)
}
