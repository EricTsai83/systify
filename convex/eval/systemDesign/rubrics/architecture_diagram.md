# Architecture Diagram Rubric

Scores a Mermaid architecture diagram on both visual quality (does it parse and read) and source faithfulness (does every node trace to real code).

## Scoring Axes

- **Faithfulness (1-5)** — Every node corresponds to a component you can find in the source. Edges represent real call / event paths. 5 = no invented nodes, no invented edges; 1 = generic boxes ("API", "Worker") not tied to files.
- **Completeness (1-5)** — Diagram + Legend + Reading guide all present and substantive. 5 = diagram covers the major flows AND the Reading guide maps each diagram node to source; 1 = bare diagram, no guide.
- **Specificity (1-5)** — Node labels are concrete (named services, named queues), not generic categories. Subgraph groupings convey meaning. 5 = 10-25 specific nodes; 1 = under 5 vague nodes.
- **Citation Quality (1-5)** — Reading guide names 3-8 highest-signal files in backticks and ties each to a diagram node. 5 = clear node-to-file mapping; 1 = no paths or wrong nodes referenced.

## Failure Signals

- Mermaid block has invalid syntax (won't parse).
- Diagram is missing the fenced ```mermaid block entirely (will fail the validator).
- Uses placeholder boxes (`?`, `TODO`, `External Service`) where it could not determine a real component.
- Node labels are vague single words ("DB", "API") with no qualifier.
- Edges have no labels and no clear direction of dependency.
- Reading guide is empty or links to `README.md` instead of code.

## Excellence Signals

- Distinguishes in-process arrows from boundary-crossing arrows with different edge styles.
- Subgraphs map cleanly to repository directories or process boundaries.
- The intro explicitly states what the diagram *omits* (e.g., "operational paths covered in Operations Overview").
- 10-25 nodes — enough to be useful, not so many the diagram becomes unreadable.

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
