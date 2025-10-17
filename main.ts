#! /usr/bin/env -S deno run --allow-read --allow-env --allow-net --allow-run=glow,bun

import { relative } from '@std/path'
import { walk } from '@std/fs/walk'
import { Command, ValidationError } from '@cliffy/command'
import $ from '@david/dax'
import { query } from '@anthropic-ai/claude-agent-sdk'

export interface Doc {
  relPath: string
  content: string
  head: string
  headings: string
}

function getIndex(dir: string): Promise<Doc[]> {
  const files = walk(dir, { includeDirs: false, exts: ['md', 'adoc'] })
  return Array.fromAsync(files, async ({ path }) => {
    const content = await Deno.readTextFile(path)
    const relPath = relative(dir, path)
    const headingPattern = path.endsWith('.adoc') ? /^=+\s+.*/gm : /^#+\s+.*/gm
    const headings = (content.match(headingPattern)?.map((h) => h.trim()) || []).join('\n')
    const head = content.slice(0, 800)
    return { relPath, content, head, headings }
  })
}

const outlineXml = (doc: Doc) =>
  $.dedent`
    <document>
      <path>${doc.relPath}</path>
      <sections>${doc.headings}</sections>
      <head>${doc.head}</head>
    </document>`

const modelMap: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-3-5-sonnet-20241022',
}

function resolveModel(modelInput: string): string {
  return modelMap[modelInput.toLowerCase()] || modelInput
}

const systemPrompt = $.dedent`
  You are a documentation assistant. Answer the user's question based on the documentation corpus.

  Below is an index of all available documents with their structure and
  previews. Use the Read tool to access full document contents when needed, or use
  Grep to search across files.

  Guidelines:
  * Give a focused answer. The user can look up more detail if necessary.
  * If you cannot find the answer in the documentation, say so. You may speculate, but be clear that you are doing so.
  * Write naturally in prose. Do not overuse markdown headings and bullets.
  * Your answer must be in markdown format.
  * This is a one-time answer, not a chat, so don't prompt for followup questions.
  * Read only the documents you need - avoid reading all documents unless necessary.
`

/////////////////////////////
// DISPLAY HELPERS
/////////////////////////////

const RENDERER = 'glow'
async function renderMd(md: string, raw = false) {
  if ($.commandExistsSync(RENDERER) && Deno.stdout.isTerminal() && !raw) {
    await $`${RENDERER}`.stdinText(md)
  } else {
    console.log(md)
  }
}

/////////////////////////////
// QUERY PROCESSING
/////////////////////////////

async function runQuery(prompt: string, model: string): Promise<string> {
  let finalAnswer = ''

  for await (
    const event of query({
      prompt,
      options: { model: resolveModel(model), executable: 'bun' },
    })
  ) {
    if (event.type === 'result') {
      // Extract text from result message
      if ('result' in event) {
        finalAnswer = event.result
      }
    }

    if (event.type === 'assistant') {
      // Track assistant responses - check message structure
      if ('message' in event) {
        const msg = event.message
        if (msg && typeof msg === 'object' && 'content' in msg) {
          const content = msg.content as Array<{ type: string; text?: string }>
          const textContent = content.find((c) => c.type === 'text')
          if (textContent?.text) {
            finalAnswer = textContent.text
          }
        }
      }
    }
  }

  return finalAnswer
}

/////////////////////////////
// DO THE THING
/////////////////////////////

await new Command()
  .name('rgd')
  .description(`LLM-only RAG Q&A based on a directory of text files`)
  .example('', "rgd ~/repos/helix/book/src 'turn off automatic bracket insertion'")
  .helpOption('-h, --help', 'Show help')
  .option('-m, --model <model>', 'Model to use (haiku or sonnet)', { default: 'haiku' })
  .arguments('<directory> <...query>')
  .action(async ({ model }, dir, ...qParts) => {
    const userQuery = qParts.join(' ')
    if (!userQuery) throw new ValidationError('query is required')

    const index = await getIndex(dir)
    const indexXml = index.map(outlineXml).join('\n')

    const prompt =
      `${systemPrompt}\n\n<document-index>\n${indexXml}\n</document-index>\n\nUser question: ${userQuery}`

    const finalAnswer = await $.progress('Searching documentation...').with(() =>
      runQuery(prompt, model)
    )

    if (finalAnswer) {
      await renderMd(finalAnswer)
    }
  })
  .parse(Deno.args)
