#! /usr/bin/env -S deno run --allow-read --allow-env --allow-net --allow-run=glow,ai

import { relative } from 'jsr:@std/path@1.0'
import { walk } from 'jsr:@std/fs@1.0/walk'
import { Command, ValidationError } from 'jsr:@cliffy/command@1.0.0-rc.7'
import $ from 'jsr:@david/dax@0.42.0'
import * as R from 'npm:remeda@2.22.1'

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
    const head = content.slice(0, 400)
    return { relPath, content, head, headings }
  })
}

const retrievalSystemPrompt = $.dedent`
  You are a document retrieval system. Determine which of the provided documents are likely to be relevant to the user's question.

  - Return at most 4 documents, but return fewer if possible. Avoid returning irrelevant documents!
  - Put most relevant documents first
  - Your response MUST be a parseable JSON array of relative paths
    - Do NOT wrap the answer in a markdown code fence
    - Do NOT include any commentary or explanation
    - Do NOT attempt to answer the question
`

const outlineXml = (doc: Doc) =>
  $.dedent`
    <document>
      <path>${doc.relPath}</path>
      <sections>${doc.headings}</sections>
      <head>${doc.head}</head>
    </document>`

/**
 * Determine which subset of the documents is relevant to the question.
 */
async function retrieve(index: Doc[], question: string, model: string) {
  const systemPrompt = [
    index.map(outlineXml).join('\n'),
    retrievalSystemPrompt,
  ].join('\n\n')
  const prompt =
    `You are a document retrieval system. Determine which of the provided documents are likely to be relevant to the user's question. Do not answer the question, only give a JSON array of relevant documents.\n\n<question>${question}</question>`
  const result = await $`ai -m ${model} -s ${systemPrompt} ${prompt} --raw`.text()

  // TODO: render narrowing result so we can see the price
  // await renderMd(['# Narrowing response', result].join('\n\n'))

  // Sometimes the model includes text other than the array, so pull out the array
  const match = result.match(/\[[^\]]*\]/)?.[0]
  if (!match) throw new Error('Could not find JSON array in response: ' + result)

  try {
    const paths: string[] = JSON.parse(match)
    // 4 is the max system prompts cacheable in the Anthropic API
    const docs = paths.slice(0, 4)
      .map((p) => index.find((doc) => doc.relPath === p))
      // TODO: warn if there's a path returned that's not in the array
      .filter((x) => !!x)
    return { content: result, docs, meta: '' }
  } catch (e) {
    console.error('Could not parse JSON', result)
    throw e
  }
}

const systemMsgBase = `
Answer the user's question concisely based on the above documentation.

* Say what document you found the answer in.
* Give a focused answer. The user can look up more detail if necessary.
* If you do not find the answer in the above sources, say so. You may speculate, but be clear that you are doing so.
* Write naturally in prose. Do not overuse markdown headings and bullets.
* Your answer must be in markdown format.
* This is a one-time answer, not a chat, so don't prompt for followup questions
`.trim()

const answerSystemMsg = systemMsgBase + `
* The documentation may be truncated, so do not assume it is comprehensive of the corpus or even all relevant documents in the corpus.`

const allDocsAnswerSystemMsg = systemMsgBase + `
* You have access to the complete documentation corpus, so you can provide comprehensive answers.`

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
// DO THE THING
/////////////////////////////

// if docs are shorter than this, don't bother narrowing
const THRESHOLD = 500_000

const numFmt = Intl.NumberFormat()

await new Command()
  .name('rgd')
  .description(`LLM-only RAG Q&A based on a directory of text files`)
  .example('', "rgd ~/repos/helix/book/src 'turn off automatic bracket insertion'")
  .helpOption('-h, --help', 'Show help')
  .option('-m, --model <model>', 'Model to use', { default: 'flash' })
  .arguments('<directory> <...query>')
  .action(async ({ model }, dir, ...qParts) => {
    const query = qParts.join(' ')
    if (!query) throw new ValidationError('query is required')

    const index = await getIndex(dir)

    const totalDocsLength = R.sumBy(index, (doc) => doc.content.length)

    if (totalDocsLength <= THRESHOLD) {
      // Skip retrieval and use all docs
      const len = numFmt.format(totalDocsLength)
      await renderMd(
        `Using full corpus (length in chars: ${len} < ${numFmt.format(THRESHOLD)})`,
      )
      const docsContent = index.map((doc) => `<document>${doc.content}</document>`).join(
        '\n',
      )
      const systemPrompt = `${allDocsAnswerSystemMsg}\n\n${docsContent}`
      await $`ai -m ${model} -s ${systemPrompt} ${query}`
      return
    }

    // Use normal retrieval process
    const retrieved = await $.progress('Finding relevant files...')
      .with(() => retrieve(index, query, model))
    const sources = retrieved.docs.length > 0
      ? retrieved.docs.map((d) => `- ${d.relPath}`).join('\n')
      : 'No relevant documents found'
    await renderMd(['# Relevant files', sources].join('\n\n'))

    if (retrieved.docs.length === 0) return // no need for second call

    const docsContent = retrieved.docs.map((doc) => `<document>${doc.content}</document>`)
      .join('\n')
    const prompt = `${query}\n\n${docsContent}`
    await $`ai -m ${model} -s ${answerSystemMsg} ${prompt}`
  })
  .parse(Deno.args)
