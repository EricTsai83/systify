# README Summary Rubric

Scores how well a README Summary captures the actual project per its own documentation, without hallucinating capabilities or audience.

## Scoring Axes

- **Faithfulness (1-5)** — Every claim about purpose, capabilities, and audience must trace to a doc the model actually read. 5 = nothing invented; 1 = clear hallucinations (services that don't exist, audiences the README doesn't address).
- **Completeness (1-5)** — All six required sections present and substantive. 5 = each section has real content; 3 = headings present but some bodies are stubs; 1 = sections missing or all "Not documented."
- **Specificity (1-5)** — Concrete capabilities, named services, exact licence/maturity. 5 = quotes / paraphrases real README phrases; 1 = vague abstractions ("a useful platform").
- **Citation Quality (1-5)** — `Source` section names actual files, in backticks. 5 = lists every doc consulted; 1 = empty / generic / wrong file names.

## Failure Signals

- Lists a "service" or "capability" that doesn't appear in the README or any cited doc.
- Audience section invents a persona ("data scientists at large enterprises") when the README doesn't address them.
- `Notable Constraints` omits the licence or maturity flag despite the README containing one.
- Uses generic phrasing ("a comprehensive system", "various features") instead of project-specific verbs.
- `Source` lists only `README.md` when the prompt allows following links and the model clearly followed none.

## Excellence Signals

- Captures the *why* the README states, not just the *what* — e.g., "exists because teams kept re-implementing X".
- Preserves the README's own emphasis: a beta-flagged project is flagged beta; an Apache-2 project is named Apache-2.
- `Key Operations` lists actual command names or workflows, not abstract user goals.

## Output Format

Return ONLY a JSON object — no prose, no code fence.

```
{
  "axes": {
    "faithfulness": <1-5>,
    "completeness": <1-5>,
    "specificity": <1-5>,
    "citationQuality": <1-5>
  },
  "comments": "<1-3 sentences pointing to the strongest and weakest aspect>"
}
```
