# Prompting Techniques Research

Deep dive into effective, efficient prompting techniques for LLMs, with a focus on Kimi K2.5/2.6 (primary target) and cross-model portability. Findings are grounded in primary sources and mapped to Finn's prompts (`identity/FINN.xml`, `prompts/hot-path.xml`).

## Headline finding: format matters, but there is no universal winner

The single most important, evidence-backed truth is that **prompt format measurably changes accuracy, and the best format is model-dependent**. This kills the simple "XML > markdown" framing.

### Microsoft/MIT, "Does Prompt Formatting Have Any Impact on LLM Performance?" (arXiv 2411.10541)

Same content, four formats (plain text, markdown, YAML, JSON), held constant:

- GPT-3.5-turbo swung up to **40%** on a code task purely from format. One MMLU case: **+42% for JSON over markdown**.
- Crucial reversal: **GPT-3.5 preferred JSON; GPT-4 preferred markdown.** Same family, opposite preference.
- Cross-model transferability (IoU of top formats) was often **below 0.2** — a format tuned for one model frequently does *not* carry to another.
- **Bigger/newer models are more robust** to format. GPT-4-turbo's performance dispersion stayed under 0.036 vs GPT-3.5's 0.035–0.176.

### improvingagents.com nested-data benchmark (GPT-5 Nano, Llama 3.2 3B, Gemini 2.5 Flash Lite)

- **YAML won** for GPT-5 Nano and Gemini; **XML came dead last** for both (Gemini: 51.9% YAML vs 33.8% XML).
- **Llama was format-agnostic** (~49–53% across all formats).
- **Markdown was the most token-efficient** (34–38% fewer tokens than JSON); **XML cost 80% more tokens than markdown** for the same data.

The Anthropic "XML is better" research is real but **specific to Claude's training**, not a law of nature. XML's wins show up most on *complex, multi-section, hierarchical* prompts and on models trained to attend to tags.

### Format preference by model (from cited benchmarks)

| Model | Best format | Worst / avoid |
|-------|-------------|---------------|
| Claude (Anthropic) | XML tags | unstructured wall |
| GPT-3.5 | JSON | markdown (on MMLU) |
| GPT-4 / 4-turbo | Markdown | JSON (code tasks) |
| GPT-5 Nano | YAML | XML |
| Gemini 2.5 Flash | YAML | XML |
| Llama 3.x | format-agnostic | none strong |
| Kimi K2.5/2.6 | delimiters: XML / triple-quote / headings | over-specifying tools |

**Takeaway:** There is no universal best format. Newer/larger models are more robust. The reliable constant across all vendors is: clearly delimit distinct sections, whatever the syntax.

## What Kimi (Moonshot) actually says

Most important since K2.5/2.6 is the primary target. From the official Kimi platform docs (prompt best practices + agent setup guide):

1. **Delimiters, format-flexible.** Kimi explicitly recommends "triple quotes / XML tags / section headings" as delimiters to separate input parts. They don't mandate XML — tags, triple quotes, and markdown headings are all valid delimiters. Finn's XML is fine for Kimi; it's not penalized.
2. **Detail and explicitness win.** "The more detailed these instructions are, the less the model has to guess." They push role definition (Role–Goal–Action priority), explicit steps, output structure/templates, and positive/negative examples to reduce ambiguity.
3. **Examples over exhaustive rules** — they explicitly endorse few-shot for hard-to-describe styles. This is exactly what FINN.xml does with its `<example type="good/bad">` pairs.
4. **Do NOT over-specify tools.** Critical for the hot path: "There is no need to specify the tools or their usage in the System Prompt, as this may actually interfere with Kimi K2.6's autonomous decision-making." Kimi decides tool use autonomously once tools are registered.
5. **Anti-fabrication via sourcing.** Their flagship example bakes in "strictly avoid fabricating data, cite sources" — the same instinct as Finn's `<knowledge_honesty>`.
6. **Length control is approximate.** Kimi (like everyone) is "better at paragraphs/bullets counts than exact word counts." Finn's "1 bubble, sometimes 2, rarely 3" is the right shape of instruction.

## What Anthropic says (the source of the XML claim)

From the current Claude prompting best-practices doc (Opus 4.x):

- **XML tags** for parsing complex prompts mixing instructions/context/examples/inputs; consistent, descriptive, nestable tag names. Wrap examples in `<example>`/`<examples>`.
- **Tell it what to DO, not what to avoid.** "Your response should be smoothly flowing prose" beats "don't use markdown." Positive examples beat negative instructions.
- **Match prompt style to desired output.** If you want no-markdown output, remove markdown from your prompt. (Finn's XML+lowercase prose body already does this.)
- **Newer models follow instructions literally** and don't generalize scope. State scope explicitly ("apply to every section, not just the first").
- **Dial back intensity on newer models.** "CRITICAL: you MUST" caused *overtriggering* on 4.5/4.6. Normal phrasing ("Use this tool when…") is now better.
- **Long context:** put long data at the top, queries/instructions at the end (up to +30% on multi-doc). Connects to "lost in the middle."

## The position effect (Stanford "Lost in the Middle")

Robust, cross-model finding: accuracy follows a **U-shaped curve** — models use info at the start and end of context best, and degrade in the middle. Practical rules:

- Put the most important instructions/constraints at the very start or very end of the system prompt.
- In long context, place bulk reference data first, the actual ask last.
- Don't bury a critical rule in the middle of a long prompt.

## Structure / language / file-format recommendations

### Structure (what works across models)

- **Delimit sections clearly** — the one universal. Tags, headings, or triple quotes all work; consistency matters more than syntax.
- **Role → Goal → Constraints → Steps → Examples → Output format** is the convergent skeleton (Kimi, Anthropic, and Google's Persona/Task/Context/Format all agree).
- **Few-shot examples** are the highest-leverage tool for tone and style (exactly Finn's use case). 3–5, relevant, diverse, wrapped in tags.
- **Positive framing** > prohibitions. Show the target shape.
- **Hierarchy via nesting** only when content genuinely is hierarchical (XML/YAML shine here; flat markdown is fine for flat content).

### Language

- Be concrete and literal; newer models don't infer unstated scope.
- Avoid stacked ALL-CAPS "CRITICAL/MUST" — overtriggers modern models. Reserve emphasis for the genuinely non-negotiable (Finn's `priority="highest"` on a few tags is the correct restraint).
- Explain *why* a rule exists — models generalize better from rationale (Anthropic + Kimi both confirm).

### File types / formats

- **XML**: best for Claude and for complex hierarchical prompts; ~80% more tokens than markdown; weakest on Gemini/GPT-5-nano for *data*.
- **Markdown**: most token-efficient; great default for GPT-4-class and simple prompts; what OpenAI historically trained on.
- **YAML**: best accuracy for nested *data* on GPT-5-nano/Gemini; clean for config-like structure.
- **JSON**: best for GPT-3.5 and for machine-parseable output; verbose; weak for Gemini/GPT-5-nano input.
- **Plain text**: surprisingly strong on some tasks (NER, some code) — never dismiss it.

## Grounding this in Finn

Finn's prompts are already well-aligned with the evidence, with a few model-portability considerations.

### What Finn does right (keep it)

- **XML structure with many `<example type="good/bad">` pairs.** The single best technique for steering tone — exactly what Finn needs. Both Kimi and Anthropic endorse example-driven style steering over rule lists.
- **Lowercase prose body inside the XML.** This is the "match prompt style to output style" trick — it actively suppresses markdown/caps in output.
- **`priority="highest"` used sparingly** (trailing_beat, completionist_answer). Correct restraint; matches "don't over-emphasize."
- **"Tell it what to do" shapes** ("land the beat, then stop") alongside the bad examples — the positive+negative pairing is ideal.
- **hot-path.xml does NOT over-script tool mechanics** beyond what's needed — aligns with Kimi's "don't interfere with autonomous tool decisions." Worth auditing whether some tool prose could be trimmed for Kimi specifically.

### Portability considerations for "a range of models"

1. **XML is safe but not optimal everywhere.** For Kimi it's an accepted delimiter (fine). For a Gemini/GPT-5-nano-class fallback, XML is the weakest *data* format and the most token-expensive. Since Finn's prompt is mostly instructions+examples (not nested data), the XML penalty is small — the data-format findings apply to payloads, not instruction scaffolding. Verdict: XML scaffolding is a reasonable cross-model choice, but it's the costliest in tokens.
2. **Token cost is real.** FINN.xml is large. XML tags add ~80% overhead vs markdown on tagged content. On a per-message hot path billed per token, consider whether lighter delimiters (markdown headings) for the bulk, reserving XML tags for example blocks, would cut cost without hurting Kimi.
3. **Position matters.** Finn's deepest tells (`trailing_beat`, `completionist_answer`) are mid-to-late in FINN.xml — good (end-weighted). But verify the most critical hard rules (emoji, lowercase, no fabrication) sit near the start or end of the assembled prompt after prompt-factory injection, not buried mid-document.
4. **Intensity calibration per model.** Finn's restrained emphasis suits modern Claude/Kimi. If routing to a smaller/older model that undertriggers, those same rules may need stronger phrasing — emphasis should be a per-model knob, not fixed.
5. **Repetition of the core tell.** The "trailing beat / completionist" rule is restated many times across FINN.xml. For robust models this risks redundancy/token waste; for weaker models repetition helps adherence. A deliberate tradeoff worth making per-model.

## Bottom line

- **No universal best format** — it's empirically model-specific, and the gap can be 40%+. Test per model.
- **The one universal rule: clearly delimit sections.** Syntax is secondary.
- **For Kimi specifically:** XML is accepted; be detailed and explicit; lead with Role/Goal; lean on good/bad examples; don't over-prescribe tool usage; bake in anti-fabrication. Finn already does most of this.
- **Examples are king for tone** — Finn's good/bad pairs are the highest-value technique in the whole file.
- **Watch token cost and position.** XML is the priciest scaffolding; keep critical rules at the edges, not the middle.
- Finn's prompts are already evidence-aligned; the main cross-model levers are token economy of XML, per-model emphasis intensity, and ensuring critical rules are edge-positioned in the assembled prompt.

## Sources

- Microsoft/MIT — "Does Prompt Formatting Have Any Impact on LLM Performance?" (arXiv:2411.10541)
- improvingagents.com — "Which Nested Data Format Do LLMs Understand Best? JSON vs YAML vs XML vs Markdown"
- Kimi / Moonshot — Platform docs: "Best Practices for Prompts" and "Use Kimi K2 Model to Setup Agent"
- Anthropic — Claude prompting best practices (Opus 4.x)
- Prompting Guide — Kimi K2.5 model page
- Stanford / Liu et al. — "Lost in the Middle: How Language Models Use Long Contexts" (arXiv:2307.03172)
- RDD10+ — "Markdown vs. XML in Prompts for LLMs: A Comparative Analysis"
