#! /usr/bin/env -S deno run --allow-read --allow-env --allow-net --allow-run=glow
import { relative } from 'jsr:@std/path@1.0'
import { walk } from 'jsr:@std/fs@1.0/walk'
import { Command, ValidationError } from 'jsr:@cliffy/command@1.0.0-rc.7'

import $ from 'jsr:@david/dax@0.42.0'
import { askClaude, type Doc } from './llm.ts'

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

const retrievalSystemPrompt = $.dedent`
  You must determine which documents are likely to be relevant to the user's question.

  - Return at most 4 documents, but return fewer if possible. Avoid returning irrelevant documents!
  - Put more relevant documents first
  - Your response MUST be an array of relative paths
  - The result must be a parseable JSON array of strings
    - Do NOT wrap the answer in a markdown code block
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
async function retrieve(index: Doc[], question: string) {
  const result = await askClaude(
    'claude-3-5-haiku-20241022',
    `<question>${question}</question>`,
    [
      { text: index.map(outlineXml).join('\n'), cache: true },
      { text: retrievalSystemPrompt },
    ],
  )
  // Sometimes the model includes text other than the array, so pull out the array
  const match = result.content.match(/\[[^\]]*\]/)?.[0]
  if (!match) throw new Error('Could not find JSON array in response: ' + result.content)

  try {
    const paths: string[] = JSON.parse(match)
    // TODO: warn if there's a path returned that's not in the array
    return {
      ...result,
      // 4 is the max system prompts cacheable in the Anthropic API
      docs: paths.slice(0, 4)
        .map((p) => index.find((doc) => doc.relPath === p))
        .filter((x) => !!x),
    }
  } catch (e) {
    console.error('Could not parse JSON', result.content)
    throw e
  }
}

const fullPromptSystemMsg = `
Answer the user's question concisely based on the above documentation.

* Give a focused answer. The user can look up more detail if necessary.
* The documentation may be truncated, so do not assume it is comprehensive of the corpus or even all relevant documents in the corpus.
* If you do not find the answer in the above sources, say so. You may speculate, but be clear that you are doing so.
* Write naturally in prose. Do not overuse markdown headings and bullets.
* Your answer must be in markdown format.
* This is a one-time answer, not a chat, so don't prompt for followup questions
`.trim()

/**
 * Pass the relevant docs to the LLM along with the question and get an answer.
 */
const getAnswer = (relevantDocs: Doc[], question: string) =>
  askClaude(
    'claude-3-5-haiku-20241022',
    question,
    [{ text: fullPromptSystemMsg }],
    relevantDocs,
  )

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

const moneyFmt = Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 5,
})

const timeFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

type ResponseMeta = { model: string; cost: number; timeMs: number }
const meta = ({ model, cost, timeMs }: ResponseMeta) =>
  `\`${model}\` | ${moneyFmt.format(cost)} | ${timeFmt.format(timeMs / 1000)} s`

/////////////////////////////
// DO THE THING
/////////////////////////////

await new Command()
  .name('rgd')
  .description(`LLM-only RAG Q&A based on a directory of text files`)
  .example('', "rgd ~/repos/helix/docs/src 'turn off automatic bracket insertion'")
  .helpOption('-h, --help', 'Show help')
  .arguments('<directory> <...query>')
  .action(async (_, dir, ...qParts) => {
    const query = qParts.join(' ')
    if (!query) throw new ValidationError('query is required')
    const index = await getIndex(dir)

    const retrieved = await $.progress('Finding relevant files...')
      .with(() => retrieve(index, query))

    const pathBullets = retrieved.docs.length > 0
      ? retrieved.docs.map((d) => `- \`${d.relPath}\``).join('\n')
      : 'No relevant documents found'
    await renderMd(`# Relevant files\n\n${meta(retrieved)}\n\n${pathBullets}`)

    if (retrieved.docs.length === 0) Deno.exit() // no need for second call

    const answer = await $.progress('Getting answer...')
      .with(() => getAnswer(retrieved.docs, query))

    await renderMd(`# Answer\n\n${meta(answer)}\n\n${answer.content}`)
  })
  .parse(Deno.args)
