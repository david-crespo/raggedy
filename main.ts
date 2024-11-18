#! /usr/bin/env -S deno run --allow-read --allow-env --allow-net --allow-run=glow
import { parseArgs } from 'jsr:@std/cli@1.0/parse-args'
import { relative } from 'jsr:@std/path@1.0'
import { walk } from 'jsr:@std/fs@1.0/walk'
import $ from 'jsr:@david/dax@0.42.0'
import { askClaude } from './llm.ts'

// TODO: CLI help string

interface Doc {
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
    const head = content.slice(0, 500)
    return { relPath, content, head, headings }
  })
}

const retrievalSystemPrompt = $.dedent`
  You must determine which documents are likely to be relevant to the user's question.

  - Return at most 4 documents, but return fewer if possible. Avoid returning irrelevant documents!
  - Put more relevant documents first
  - Your response MUST be an array of relative paths
  - The result must be parseable JSON. Do not wrap the answer in a markdown code block and do not attempt to answer the question.
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
  const paths: string[] = JSON.parse(result.content)
  // TODO: warn if there's a path returned that's not in the array
  return {
    ...result,
    // 4 is the max system prompts cacheable in the Anthropic API
    docs: paths.slice(0, 4)
      .map((p) => index.find((doc) => doc.relPath === p))
      .filter((x) => !!x),
  }
}

const fullPromptSystemMsg = `
Answer the user's question based on the above documentation.

* The documentation may be truncated, so do not assume it is comprehensive of the corpus or even all relevant documents in the corpus.
* If you do not find the answer in the above sources, say so. You may speculate, but be clear that you are doing so.
* Write naturally in prose. Do not overuse markdown headings and bullets.
* Your answer must be in markdown format.
* This is a one-time answer, not a chat, so don't prompt for followup questions
`.trim()

const fullDocXml = (doc: Doc) =>
  $.dedent`
    <document>
      <path>${doc.relPath}</path>
      <document_content>${doc.content}</document_content>
    </document>
  `

/**
 * Pass the relevant docs to the LLM along with the question and get an answer.
 */
const getAnswer = (relevantDocs: Doc[], question: string) =>
  askClaude(
    'claude-3-5-haiku-20241022',
    question,
    [
      // pass in relevant docs as separate system prompts so they can be cached
      ...relevantDocs.map((doc) => ({ text: fullDocXml(doc), cache: true })),
      // instructions at the end, per Anthropic API guidelines
      { text: fullPromptSystemMsg },
    ],
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
