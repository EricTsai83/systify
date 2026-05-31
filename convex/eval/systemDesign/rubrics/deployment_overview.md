# Deployment Overview Rubric

Scores how well a Deployment Overview describes how the project actually runs in production, sourced from infrastructure code.

## Scoring Axes

- **Faithfulness (1-5)** — Runtime targets, pipelines, and environment management match the deployment config. 5 = every claim traces to a Dockerfile / CI workflow / Terraform module; 1 = describes a deployment shape the code doesn't actually use.
- **Completeness (1-5)** — All five required sections present and substantive. 5 = covers runtime, pipeline, env/secrets, dependencies, and pointer files; 3 = headings present but bodies thin; 1 = sections missing.
- **Specificity (1-5)** — Names actual hosts, services, and pipeline steps. 5 = "ECS Fargate behind one ALB"; 1 = "deployed to the cloud".
- **Citation Quality (1-5)** — File paths in backticks for each claim. 5 = every section has a concrete pointer; 1 = no paths or wrong paths.

## Failure Signals

- Describes a deployment platform the project doesn't actually use (e.g., Kubernetes when it's Fargate).
- `Environment & Secrets` says "via environment variables" without naming where they come from.
- `Build & Release Pipeline` paraphrases CI in abstract terms instead of citing the workflow file.
- `Infrastructure Dependencies` omits the database / cache the project clearly uses.
- `Where to Look First` points at top-level docs instead of CI workflow files / Dockerfiles / Terraform modules.

## Excellence Signals

- Distinguishes the staging / production differences when the config encodes them.
- Notes the migration-before-deploy ordering when CI enforces it.
- Surfaces operationally-relevant secrets handling — rotation runbook, key-encryption-key location.

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
